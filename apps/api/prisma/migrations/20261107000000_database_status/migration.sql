-- AlterTable
ALTER TABLE "Database" ADD COLUMN     "error" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'READY';

