import type { RpcStub } from "@fungi.computer/capnweb";

import type { AppError } from "../errors.js";
import type { AppClientRpc } from "./protocol.js";

import { callRpc } from "./result.js";
import { parseErrorData, parseVoidResult } from "./schemas.js";

export async function disconnectHost(
  error: AppError | undefined,
  assertLive: () => void,
  options: {
    readonly client: RpcStub<AppClientRpc>;
    readonly onGracefulDisconnect: () => Promise<void>;
  },
  dispose: () => void,
): Promise<void> {
  assertLive();
  try {
    const data =
      error === undefined
        ? undefined
        : parseErrorData({
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          });
    await callRpc(options.client.disconnect(data), parseVoidResult);
    await options.onGracefulDisconnect();
  } finally {
    dispose();
  }
}
