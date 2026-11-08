-- FR-IAM-6 / FR-IAM-7: Keycloak events copied into the audit log, and per-person token revocation.
ALTER TABLE "User" ADD COLUMN "tokensValidAfter" TIMESTAMP(3);
ALTER TABLE "AuditLogEntry" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "AuditLogEntry_sourceKey_key" ON "AuditLogEntry"("sourceKey");
