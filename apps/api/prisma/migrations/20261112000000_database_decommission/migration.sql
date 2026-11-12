-- Database deprovisioning: when a provisioned database and its role were dropped (status DECOMMISSIONED).
ALTER TABLE "Database" ADD COLUMN "decommissionedAt" TIMESTAMP(3);
