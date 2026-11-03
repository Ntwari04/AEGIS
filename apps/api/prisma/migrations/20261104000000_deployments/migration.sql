-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "containerPort" INTEGER NOT NULL DEFAULT 3000,
ADD COLUMN     "healthPath" TEXT NOT NULL DEFAULT '/healthz',
ADD COLUMN     "imageRepo" TEXT;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "containerName" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "logs" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "restoredFromId" TEXT,
ADD COLUMN     "triggerSource" TEXT NOT NULL DEFAULT 'manual';

