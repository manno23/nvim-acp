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

export type CapnpRequest =
  | {
      type: "call";
      interfaceId: string;
      method: string;
      payload: unknown;
    }
  | {
      type: "cancel";
      callId: string;
    };

export interface CapnpResponse {
  type: "return" | "exception" | "event";
  callId?: string;
  payload?: unknown;
  event?: unknown;
  error?: { message: string };
}

export interface JobHandle {
  id: string;
}

export interface FactsSubscriptionHandle {
  id: string;
}

export interface SubmitResponse {
  job: JobHandle;
}

export interface CancelParams {
  jobId: string;
}

export interface SubscribeFactsParams {
  meta: FactMeta;
  filters: FactFilter[];
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

export type JobEvent = {
  jobId: string;
  event: ActionEvent;
};

export type JobResultEvent = {
  jobId: string;
  result: ActionResult;
};

export type FactNotification = {
  subscriptionId: string;
  fact: unknown;
};
