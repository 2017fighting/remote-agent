// Image glue for the App container: the bundle at /app/main.mjs exports
// `startApp()` and does not call it, because the module is also the App's
// composition root under test. This file is the process entrypoint, so the
// image never ships a `CMD` that exits without starting anything.
import { startApp } from "./main.mjs";

const app = await startApp();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    app.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
