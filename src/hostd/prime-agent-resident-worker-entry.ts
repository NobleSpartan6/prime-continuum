import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ResidentRuntimeWorkerServer } from "./prime-agent-resident-worker-server";
import {
  validateResidentWorkerBootstrap,
  type ResidentWorkerBootstrap,
} from "./prime-agent-resident-worker-protocol";

/**
 * Starts the isolated Prime Agent transport server from the already-loaded,
 * packaged hostd bundle. Keeping this as an explicit export lets the fixed
 * Worker bootstrap require the same trusted artifact without a second worker
 * bundle or a source-controlled dynamic entrypoint.
 */
export function runPrimeAgentResidentWorker(
  bootstrapValue: ResidentWorkerBootstrap | unknown = workerData,
): void {
  if (isMainThread || !parentPort) {
    throw new Error("Prime Agent resident worker entrypoint must run inside a Worker thread");
  }
  const server = new ResidentRuntimeWorkerServer({
    bootstrap: validateResidentWorkerBootstrap(bootstrapValue),
    port: parentPort,
  });
  void server.start();
}
