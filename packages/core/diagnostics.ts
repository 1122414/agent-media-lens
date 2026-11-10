import { channel } from "node:diagnostics_channel";
import type { Stage, Media } from "./contracts.js";

export const diagnostics = channel("agent-media-lens:diagnostics");
// Only these fields may reach stderr: never publish URLs, headers or source text.
type Diagnostic =
  | {
      event: "http";
      hostname: string;
      status: number;
      hop: number;
      elapsedMs: number;
    }
  | { event: "redirect"; fromHost: string; toHost: string; hop: number }
  | {
      event: "retry";
      code: string;
      hostname?: string;
      httpStatus?: number;
      attempt: number;
      delayMs: number;
    }
  | {
      event: "provider";
      provider: "native" | "evil0ctal";
      platform: Media["platform"];
    }
  | { event: "rendition"; platform: Media["platform"]; kind: string }
  | {
      event: "stage";
      taskId: string;
      stage: Stage;
      previousStage: Stage;
      elapsedMs: number;
      code?: string;
    };
export function trace(event: Diagnostic) {
  if (diagnostics.hasSubscribers) diagnostics.publish(event);
}
