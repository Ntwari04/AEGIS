-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "RestoreKind" AS ENUM ('RESTORE', 'OVERWRITE', 'DRILL');

-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- DropForeignKey
ALTER TABLE "BackupJob" DROP CONSTRAINT "BackupJob_databaseId_fkey";

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "cordonReason" TEXT,
ADD COLUMN     "cordoned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cordonedAt" TIMESTAMP(3),
ADD COLUMN     "cordonedById" TEXT;

-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "environmentId" TEXT,
ADD COLUMN     "pgName" TEXT NOT NULL,
ADD COLUMN     "roleName" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BackupJob" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "kind" "BackupKind" NOT NULL DEFAULT 'SCHEDULED',
ADD COLUMN     "manifest" JSONB,
ADD COLUMN     "plainBytes" BIGINT,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "target" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "triggeredById" TEXT,
ALTER COLUMN "databaseId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "RestoreJob" (
    "id" TEXT NOT NULL,
    "backupJobId" TEXT NOT NULL,
    "kind" "RestoreKind" NOT NULL DEFAULT 'RESTORE',
    "status" "RestoreStatus" NOT NULL DEFAULT 'RUNNING',
    "targetDatabase" TEXT NOT NULL,
    "requestedById" TEXT,
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "integrity" JSONB,
    "error" TEXT,

    CONSTRAINT "RestoreJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestoreJob_kind_startedAt_idx" ON "RestoreJob"("kind", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Database_pgName_key" ON "Database"("pgName");

-- CreateIndex
CREATE UNIQUE INDEX "Database_roleName_key" ON "Database"("roleName");

-- CreateIndex
CREATE INDEX "BackupJob_target_startedAt_idx" ON "BackupJob"("target", "startedAt");

-- AddForeignKey
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoreJob" ADD CONSTRAINT "RestoreJob_backupJobId_fkey" FOREIGN KEY ("backupJobId") REFERENCES "BackupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

