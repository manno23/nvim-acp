import type { RpcTarget } from "capnweb";

export interface Artifact {
  id: string;
  uri: string;
  mediaType: string;
  digest?: string;
  size?: number;
}

export interface ActionRequest {
  action: string;
  parameters: Record<string, unknown>;
  artifacts?: Artifact[];
  clientContext?: Record<string, unknown>;
}

export interface ActionResult {
  status: "success" | "failure" | "canceled";
  message?: string;
  artifacts?: Artifact[];
  metrics?: Record<string, number>;
}

export interface ActionEvent {
  kind: "log" | "progress" | "artifact" | "diagnostic" | "heartbeat";
  timestamp: string;
  message?: string;
  progress?: {
    current: number;
    total?: number;
    phase?: string;
  };
  artifact?: Artifact;
  diagnostic?: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    severity: "error" | "warning" | "info" | "hint";
    message: string;
  };
}

export interface FactMeta {
  scope: string;
  cursor?: string;
}

export interface FactFilter {
  kind: string;
  value?: string;
}

export interface FactRecord {
  id: string;
  scope: string;
  payload: Record<string, unknown>;
}

export interface JobObserver extends RpcTarget {
  event(event: ActionEvent): void;
  result(result: ActionResult): void;
}

export interface FactsObserver extends RpcTarget {
  fact(record: FactRecord): void;
  closed(reason?: string): void;
}

export interface Job extends RpcTarget {
  watch(observer: JobObserver): void;
  cancel(): void;
}

export interface FactsSubscription extends RpcTarget {
  observe(observer: FactsObserver): void;
  close(): void;
}

export interface Acp extends RpcTarget {
  submit(request: ActionRequest): Job;
  subscribeFacts(meta: FactMeta, filters: FactFilter[]): FactsSubscription;
}

export interface BridgeEvent {
  method: "event" | "fact" | "disconnect";
  params: Record<string, unknown>;
}

export interface BridgeRequest {
  id: number;
  method: "connect" | "submit" | "cancel" | "subscribeFacts" | "closeFacts";
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

export interface BridgeConfig {
  url?: string;
  token?: string;
  connectTimeoutMs?: number;
}

export type JobEventPayload = {
  jobId: string;
  event: ActionEvent;
};

export type JobResultPayload = {
  jobId: string;
  result: ActionResult;
};

export type FactPayload = {
  subscriptionId: string;
  fact: FactRecord;
};
