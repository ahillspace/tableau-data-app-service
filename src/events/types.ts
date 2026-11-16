/** An event as streams deliver it. */
export type ServiceEvent = {
  id: string;
  definitionId: string;
  type: string;
  account: string;
  payload: unknown;
  receivedAt: string;
};

export type LossReason =
  | "stream-start"
  | "slow-client"
  | "fan-out-reconnected"
  | "fan-out-unavailable";

/**
 * Carries events between API replicas. Delivery is lossy: no replay and no backlog.
 * `onLoss` fires when the bus may have missed events (disconnect, reconnect).
 */
export interface EventBus {
  publish(event: ServiceEvent): Promise<void>;
  start(handlers: {
    onEvent(event: ServiceEvent): void;
    onLoss(reason: LossReason): void;
  }): Promise<void>;
  readonly ready: boolean;
  close(): Promise<void>;
}
