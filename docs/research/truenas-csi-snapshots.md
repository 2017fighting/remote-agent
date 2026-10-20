# TrueNAS CSI snapshot semantics and PVC lifecycle

Research note for [issue #9](https://github.com/2017fighting/remote-agent/issues/9):
"每个 Job 从 base PVC 的 CSI 快照起步" — what the TrueNAS CSI driver actually does
with `VolumeSnapshot` and restored PVCs.

Every claim below is tagged:

- **Direct evidence** — quoted/paraphrased from a primary source, with path+line or URL.
- **Interpretation** — my reading of direct evidence, stated as such.
- **Inference** — a conclusion I draw that the sources do not state outright.
- **未确认 (unconfirmed)** — not established from a primary source.

## Sources and revisions

| Source | Revision |
|---|---|
| `/root/clone/truenas-csi` (upstream driver) | `6443642bed8122afd83847c4b81ceb9f50fc1cf8` = tag v1.4.0 |
| `/root/clone/home-ops` (cluster GitOps) | `a20dcea58ed1ec77e43cfdbe11e866644d6d103e` |
| CSI spec v1.12.0 (matches driver `go.mod`) | https://raw.githubusercontent.com/container-storage-interface/spec/v1.12.0/spec.md |
| Kubernetes docs (Access Modes) | https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/concepts/storage/persistent-volumes.md |
| OpenZFS man page `zfsprops(7)` | https://openzfs.github.io/openzfs-docs/man/master/7/zfsprops.7.html |
| Live cluster `home` | `kubectl` against the current kubeconfig, 2026-10-20 |

Cluster access was available; the `kubectl` evidence below is direct, not inferred.

---

## Q1. `VolumeSnapshot` behaviour for RWO / RWX PVCs; can a restored PVC attach on another node?

**Snapshot creation is access-mode-agnostic. Direct evidence.** The CSI
`CreateSnapshotRequest` carries only `source_volume_id`, `name`, `secrets` and
opaque `parameters` — there is no `volume_capability` / access-mode field
([spec v1.12.0, `CreateSnapshotRequest`](https://raw.githubusercontent.com/container-storage-interface/spec/v1.12.0/spec.md),
lines 1933–1961). The driver's `CreateSnapshot` likewise never reads an access
mode; it snapshots `volInfo.DatasetPath` directly
(`pkg/driver/controller.go:1893-1969`, snapshot call at
`pkg/driver/controller.go:1949`). So RWO and RWX PVCs are snapshotted the same
way: a ZFS snapshot of the backing dataset.

**The restored volume is an independent ZFS clone. Direct evidence.** A volume
restored from a `VolumeSnapshot` is created via `CloneSnapshot`
(`pkg/driver/controller.go:1197`, `pkg/client/storage.go:1178-1187`) and, per
the driver's own docs, "is a ZFS clone: it shares the blocks it has in common
with its source, so it costs only the space its changes take"
(`docs/snapshots.md:5-8`). It is a *different* dataset from the source, so the
source PVC's attach state does not gate it.

**The driver binds no volume to any node. Direct evidence.** The driver
deliberately does not advertise `VOLUME_ACCESSIBILITY_CONSTRAINTS`:

> `VOLUME_ACCESSIBILITY_CONSTRAINTS is deliberately absent: TrueNAS storage is
> network-attached and reachable from every node, so no volume is bound to a
> subset of them. See NodeGetInfo.`
> — `pkg/driver/driver.go:838-839`

`NodeGetInfo` returns only `NodeId` and no `accessible_topology`
(`pkg/driver/node.go:481-488`). `ControllerPublishVolume` performs no node
bookkeeping and no affinity check (`pkg/driver/controller.go:1622-1746`);
`ControllerUnpublishVolume` is an explicit no-op
(`pkg/driver/controller.go:1750-1759`). The provisioner runs without the
topology feature gate for the same reason
(`deploy/truenas-csi-driver.yaml:310-311`).

**Kubernetes access-mode contract. Direct evidence.**

> `ReadWriteOnce` : the volume can be mounted as read-write by a single node.
> `ReadWriteMany` : the volume can be mounted as read-write by many nodes.
> — https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/concepts/storage/persistent-volumes.md
> ("Access Modes")

**Answer. Interpretation of the above.** A PVC restored from a snapshot can be
attached on any node, including one different from wherever the base PVC is
mounted:

- RWX (the `truenas-nfs-retain` storage class; `home-ops/infrastructure/storage/storageclass-truenas-nfs.yaml:10-11`)
  — NFS, so many nodes at once.
- RWO — Kubernetes enforces *one node at a time*, but the node is not fixed;
  the restored PV has no node affinity, so wherever the Job pod is scheduled,
  the volume attaches there. The base PVC's RWO attach is irrelevant because
  the restored volume is a separate PV/dataset.

**Inference (not stated by a source):** the "single node" half of RWO is
enforced by the Kubernetes attach/detach layer, not by this driver — the driver
does no attachment tracking. The live cluster already runs many `RWO` PVCs on
the NFS class (see cluster evidence), which shows RWO is a k8s-level constraint
here, not a driver one.

**Unconfirmed:** whether the base PVC's own access mode must match the restored
PVC's. The driver ignores access modes on the restore path
(`pkg/driver/controller.go:1185-1264`), and the Kubernetes snapshot docs
describe only a *volume mode* (Filesystem/Block) conversion guard, not an
access-mode one
(https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/concepts/storage/volume-snapshots.md,
"Converting the volume mode of a Snapshot"). No primary source found that
requires the access modes to match, but I did not find a source that says they
may differ either, so this is left unconfirmed.

---

## Q2. Cost of create/delete; ZFS snapshot? What deleting a `VolumeSnapshot` does; the two `deletionPolicy` values

**It is a ZFS snapshot. Direct evidence.**

> `A VolumeSnapshot is a ZFS snapshot of the volume's dataset, <dataset>@<name>,
> where the name comes from the Kubernetes snapshotter: snapshot-<uid> unless
> its --snapshot-name-prefix is changed.`
> — `docs/snapshots.md:3-5`

Confirmed live: the csi-snapshotter runs without `--snapshot-name-prefix`
(`kubectl -n truenas-csi get deploy truenas-csi-controller -o jsonpath=...`;
upstream `deploy/truenas-csi-driver.yaml:343-349`), and existing
`VolumeSnapshotContent.status.snapshotHandle` values are of the form
`nova/k8s/pvc-280f6998-660d-486a-adb6-5fd8a59b8a5f@snapshot-<uid>` (cluster
evidence below).

**Create cost. Direct evidence.** One `snapshot.create` API call
(`pkg/client/storage.go:1146-1159`, called from
`pkg/driver/controller.go:1949`). ZFS snapshots are metadata-only (no data
copy) — **Interpretation** of ZFS semantics, consistent with the driver's
statement that a clone "shares the blocks it has in common with its source"
(`docs/snapshots.md:6-8`). The response is returned `ReadyToUse: true`
immediately (`pkg/driver/controller.go:1959-1967`).

**Delete cost and deferred destroy. Direct evidence.**

> `The driver deletes snapshots with the destroy deferred, so ZFS removes each
> one at the right moment: Deleting a VolumeSnapshot removes it from Kubernetes
> at once. If a volume restored from it still exists, TrueNAS keeps the ZFS
> snapshot, marked for destruction, until that volume is deleted too. The driver
> no longer lists it.`
> — `docs/snapshots.md:12-18`

Implementation: `client.DeleteSnapshot` always sends `{defer: true}`
(`pkg/client/storage.go:1165-1167`), and the driver filters deferred snapshots
out of queries via the `defer_destroy` property
(`pkg/client/storage.go:1195-1215`).

**`deletionPolicy` values. Direct evidence (CRD description).**

> `"Retain" means that the VolumeSnapshotContent and its physical snapshot on
> underlying storage system are kept. "Delete" means that the
> VolumeSnapshotContent and its physical snapshot on underlying storage system
> are deleted.`
> — `home-ops/infrastructure/snapshot-controller/00-crds.yaml:48-55`

Consequences for this driver:

- **`Delete`** — the snapshot controller calls CSI `DeleteSnapshot`
  (`pkg/driver/controller.go:1971-2000`), which issues the deferred ZFS
  destroy. No restored volume → destroyed at once; restored volume still alive
  → ZFS holds it (marked for destruction) until that volume is deleted
  (`docs/snapshots.md:16-18`). The cluster currently uses `Retain`, not `Delete`.
- **`Retain`** — CSI `DeleteSnapshot` is never called, so the ZFS snapshot stays
  and keeps counting against the source dataset's `usedbysnapshots`
  (`docs/snapshots.md:23-24`). **Important caveat, direct evidence from the
  home-ops repo:** `Retain` does *not* protect the ZFS snapshot from the
  driver's recursive volume delete. `DeleteVolume` ends with
  `DeleteDataset(..., {Recursive: true, Force: true})`
  (`pkg/driver/controller.go:1612`), and home-ops documents the resulting loss:

  > `the Retain deletionPolicy did not save them: Retain protects a
  > VolumeSnapshotContent from the CSI deletion path, not a ZFS snapshot from a
  > recursive dataset delete, and the driver's DeleteVolume passes
  > {recursive: true, force: true}.`
  > — `home-ops/infrastructure/database/cnpg-cluster/cluster.yaml:90-94`

**Pre-v1.4.0 leftovers. Direct evidence.** Before v1.4.0 the driver deleted
without deferring, leaving `csi-clone-*` and orphan `snapshot-*` snapshots on
source volumes (`docs/snapshots.md:26-55`). The cluster runs v1.4.0
(`kubectl` evidence), so the fixed path applies; the driver also sweeps leftover
`csi-clone-*` snapshots at startup (`pkg/driver/snapshot_sweep.go:50-80`).

---

## Q3. What state must the base PVC be in before snapshotting (must it be unmounted? consistency?)

**No unmount or state precondition. Direct evidence.** `CreateSnapshot` looks
up the volume, checks the name is free, and calls `snapshot.create`; it never
queries or asserts mount state, and it does not need the volume attached
(`pkg/driver/controller.go:1893-1969`). The CSI spec's only state requirement
is that the call "MUST block until the snapshot is cut"
(https://raw.githubusercontent.com/container-storage-interface/spec/v1.12.0/spec.md,
`CreateSnapshot`), which the driver satisfies synchronously before returning
`ReadyToUse: true`.

**No freeze/thaw is wired up. Direct evidence.** The Kubernetes
`VolumeSnapshot` CRD has only `spec.source.persistentVolumeClaimName` /
`volumeSnapshotContentName` and `spec.volumeSnapshotClassName` — no freeze or
quiesce field (`home-ops/infrastructure/snapshot-controller/00-crds.yaml`,
`VolumeSnapshot` schema; a grep for `freeze`/`thaw`/`quiesce` in that file
returns nothing). The CSI spec permits the CO to freeze, but does not require
it:

> `The CO MAY freeze the application using the source volume before taking the
> snapshot. The purpose of freeze is to ensure the application data is in
> consistent state.`
> — https://raw.githubusercontent.com/container-storage-interface/spec/v1.12.0/spec.md,
> "The ready_to_use Parameter"

**Answer. Interpretation.** The base PVC may stay mounted and in use; no unmount
is required. The snapshot is atomic at the ZFS level, so it is
**crash-consistent**, not application-consistent, unless the caller quiesces the
writer itself. For the Job use case, this is only a real concern if the base PVC
is being written while snapshots are taken; a static base makes it moot.

---

## Q4. Does home-ops already have the snapshot controller and a `VolumeSnapshotClass` (`truenas-snapclass`)?

**Snapshot controller: yes, installed. Direct evidence.**

- CRDs vendored: `home-ops/infrastructure/snapshot-controller/00-crds.yaml`
  (registered via `infrastructure/snapshot-controller/kustomization.yaml:32-35`).
- Controller deployed in `kube-system`, 2 replicas, image
  `snapshot-controller:v8.6.0`
  (`home-ops/infrastructure/snapshot-controller/20-controller.yaml:9-35`).
- Live: `kube-system/snapshot-controller-5695d87d66-{dczr5,fjz7g} 1/1 Running`,
  deployment `snapshot-controller 2/2`.
- The driver's `csi-snapshotter` sidecar is v8.6.0 in the live pod
  (`home-ops/infrastructure/storage/kustomization.yaml:55-56`).

**`VolumeSnapshotClass`: yes, but it is named `truenas-csi`, not
`truenas-snapclass`. Direct evidence.**

```yaml
# home-ops/infrastructure/storage/volumesnapshotclass.yaml
metadata:
  name: truenas-csi
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: csi.truenas.io
deletionPolicy: Retain
```

Live confirmation (`kubectl get volumesnapshotclass`): exactly one class,
`truenas-csi`, driver `csi.truenas.io`, `deletionPolicy: Retain`, default class.

**The ticket's assumed name does not exist in the cluster. Direct evidence.**
`truenas-snapclass` appears only in upstream's
`examples/volumesnapshotclass.yaml:6`, with `deletionPolicy: Delete`
(`examples/volumesnapshotclass.yaml:8`). The Helm chart's default name is a
third spelling, `truenas-snapshotclass`
(`charts/truenas-csi/values.yaml:197-201`), and it is disabled by default
(`enabled: false`). home-ops does not use the chart; it vendors
`deploy/truenas-csi-driver.yaml` (`home-ops/infrastructure/storage/kustomization.yaml:2-3`).

**Conclusion:** a `VolumeSnapshotClass` is installed and usable, but any manifest
must reference `truenas-csi`. Also note the live policy is `Retain`, not the
`Delete` the upstream example implies — see Q2 for why that matters.

---

## Q5. Pressure and quota for one snapshot + one PVC per Job, at 3 concurrency

**Snapshot and clone cost is per-call, not per-byte. Direct evidence /
Interpretation.**

- 3 concurrent `CreateSnapshot` calls on the same base dataset: three
  `snapshot.create` calls, metadata-only ZFS snapshots. The driver takes no
  lock on this path — the only mutex is `cloneSnapshotMu`, used for the
  PVC-from-PVC clone path (`pkg/driver/controller.go:164-167`,
  `pkg/driver/snapshot_sweep.go:23-25`), not for snapshotting. Each call is a
  websocket round-trip; the csi-snapshotter sidecar runs with
  `--leader-election=true` (`deploy/truenas-csi-driver.yaml:343-349`), so one
  controller instance drives them.
- 3 restored PVCs: three ZFS clones that share blocks with the base
  (`docs/snapshots.md:5-8`); each pays only for its own changed blocks.

**Space accounting and quota. Direct evidence + Interpretation.**

- Snapshot space is counted against the **source dataset's**
  `usedbysnapshots`: "While a snapshot is kept for a clone, the blocks it holds
  are counted against the source volume's dataset on TrueNAS"
  (`docs/snapshots.md:23-24`; OpenZFS defines `usedbysnapshots` as "The amount
  of space consumed by snapshots of this dataset",
  https://openzfs.github.io/openzfs-docs/man/master/7/zfsprops.7.html).
- The driver sets **`refquota`** (NFS) or **`volsize`/`refreservation`** (zvol),
  never `quota` (`pkg/driver/controller.go:516,697,1221,1296,2215`; no
  `Quota:`/`.Quota` assignment anywhere in `pkg/driver`).
- OpenZFS: `refquota` "does not include space used by descendants, including
  file systems and snapshots", while `quota` "includes all space consumed by
  descendants, including file systems and snapshots"
  (https://openzfs.github.io/openzfs-docs/man/master/7/zfsprops.7.html).
  **Therefore snapshots do not consume the base PVC's `refquota`; they consume
  pool free space.**
- Each restored volume gets its own quota: `refquota = requested` for NFS, or
  `volsize` (plus `refreservation` for thick zvols) for block protocols
  (`pkg/driver/controller.go:1205-1223`). The clone's own writes are bounded by
  its own quota, not the base's.

**Cleanup determines whether space is reclaimed. Direct evidence.**

- `deletionPolicy: Delete`: deleting the `VolumeSnapshot` while a restored PVC
  exists leaves the ZFS snapshot in place until that PVC is deleted
  (`docs/snapshots.md:16-18`). A Job that keeps its restored PVC therefore also
  keeps the snapshot's space. Deleting the PVC (`DeleteVolume` →
  recursive dataset delete, `pkg/driver/controller.go:1612`) frees the clone and
  lets ZFS destroy the snapshot.
- `deletionPolicy: Retain` (what the cluster actually runs): CSI delete is never
  called, so the ZFS snapshot persists until the source dataset is deleted
  (recursive delete removes it too — `home-ops/infrastructure/database/cnpg-cluster/cluster.yaml:90-94`).

**Answer. Interpretation.** At 3 concurrency the driver/TrueNAS load is
negligible: three metadata-only snapshots plus three block-sharing clones, no
per-byte copy. The real constraint is *space accumulation*, not IOPS or API
pressure: each retained or not-yet-cleaned snapshot pins the base's diverged
blocks in pool space. To keep it bounded, delete the restored PVC (and, under
`Delete`, the `VolumeSnapshot`) when the Job finishes; a static base PVC that
never diverges keeps the pinned space near zero.

**Unconfirmed:** the actual pool free space and the base PVC's current
`usedbysnapshots` on the TrueNAS appliance. The driver's API key is in a
SOPS-encrypted secret (`home-ops/infrastructure/storage/truenas-csi-secret.sops.yaml`),
so I did not query the appliance directly.

---

## Cluster evidence (commands and raw output)

All run against the `home` cluster kubeconfig on 2026-10-20.

```
$ kubectl get volumesnapshotclass
NAME          DRIVER           DELETIONPOLICY   AGE
truenas-csi   csi.truenas.io   Retain           102d

$ kubectl get volumesnapshotclass truenas-csi -o jsonpath='{.metadata.annotations}'
{"snapshot.storage.kubernetes.io/is-default-class":"true"}

$ kubectl get storageclass
truenas-iscsi-retain   csi.truenas.io   Retain   Immediate   true   101d
truenas-nfs-retain     csi.truenas.io   Retain   Immediate   true   102d

$ kubectl -n truenas-csi get deploy truenas-csi-controller -o jsonpath='{.spec.template.spec.containers[*].image}'
harbor.raenzo.com:8443/ghcr/truenas/truenas-csi:v1.4.0
harbor.raenzo.com:8443/k8s/sig-storage/csi-provisioner:v6.4.0
harbor.raenzo.com:8443/k8s/sig-storage/csi-attacher:v4.13.0
harbor.raenzo.com:8443/k8s/sig-storage/csi-snapshotter:v8.6.0
harbor.raenzo.com:8443/k8s/sig-storage/csi-resizer:v2.3.0
harbor.raenzo.com:8443/k8s/sig-storage/livenessprobe:v2.20.0

$ kubectl -n kube-system get deploy snapshot-controller
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
snapshot-controller   2/2     2            2           102d

$ kubectl get volumesnapshotcontent -o jsonpath='{range .items[*]}{.status.snapshotHandle}{"\n"}{end}' | sort -u | head -1
nova/k8s/pvc-280f6998-660d-486a-adb6-5fd8a59b8a5f@snapshot-0013242f-92a1-420b-abc2-6ee45a63792f

$ kubectl get volumesnapshotcontent --no-headers | wc -l
264

$ kubectl get nodes -o name
node/home-cp-0
node/home-cp-1
node/home-cp-2
```

The 264 `VolumeSnapshotContent` objects are the daily `pg-cluster-1` CNPG
backups (`kubectl get volumesnapshot -n database`), i.e. the snapshot path is
already exercised at scale in this cluster, not just theoretically available.
