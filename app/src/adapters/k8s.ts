import type { K8sPort } from "../ports/K8sPort.js";

/**
 * Production K8sPort implementation backed by `@kubernetes/client-node`.
 * Not implemented in this ticket (#34): production adapters live in later
 * tickets; the decision layer talks to the port, never to this file.
 */
export class KubeClientK8s implements K8sPort {
  constructor(_config: { namespace: string }) {
    void _config;
  }

  private notImplemented(method: string): never {
    throw new Error(`KubeClientK8s.${method} not implemented (ticket #34 only defines ports)`);
  }

  getJob(): Promise<never> {
    return this.notImplemented("getJob");
  }
  listJobs(): Promise<never> {
    return this.notImplemented("listJobs");
  }
  createJob(): Promise<never> {
    return this.notImplemented("createJob");
  }
  watchJobs(): Promise<never> {
    return this.notImplemented("watchJobs");
  }
  listPods(): Promise<never> {
    return this.notImplemented("listPods");
  }
  getPod(): Promise<never> {
    return this.notImplemented("getPod");
  }
  getPodLog(): Promise<never> {
    return this.notImplemented("getPodLog");
  }
  createSecret(): Promise<never> {
    return this.notImplemented("createSecret");
  }
  getSecret(): Promise<never> {
    return this.notImplemented("getSecret");
  }
  patchSecretAnnotations(): Promise<never> {
    return this.notImplemented("patchSecretAnnotations");
  }
  deleteSecret(): Promise<never> {
    return this.notImplemented("deleteSecret");
  }
  createPvc(): Promise<never> {
    return this.notImplemented("createPvc");
  }
  getPvc(): Promise<never> {
    return this.notImplemented("getPvc");
  }
  listPvcs(): Promise<never> {
    return this.notImplemented("listPvcs");
  }
  patchPvcAnnotations(): Promise<never> {
    return this.notImplemented("patchPvcAnnotations");
  }
  clearPvcAnnotation(): Promise<never> {
    return this.notImplemented("clearPvcAnnotation");
  }
  deletePvc(): Promise<never> {
    return this.notImplemented("deletePvc");
  }
}
