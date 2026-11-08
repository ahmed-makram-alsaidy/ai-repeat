export interface TaskEvent {
  event: string;
  taskId: string;
  at: string;
  stepId?: string;
  data?: Record<string, unknown>;
}
