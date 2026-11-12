-- Database password rotation: when it last happened, and why the last attempt failed.
ALTER TABLE "Database" ADD COLUMN "passwordRotatedAt" TIMESTAMP(3),
ADD COLUMN "rotationError" TEXT;
