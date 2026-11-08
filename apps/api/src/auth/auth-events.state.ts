/** Shared between the ingest service and the metrics: when Keycloak events were last copied into the audit log. */
export const authEventsState: { enabled: boolean; lastOkSeconds: number } = { enabled: false, lastOkSeconds: 0 };
