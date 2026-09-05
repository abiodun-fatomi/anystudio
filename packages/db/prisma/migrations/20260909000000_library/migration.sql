-- Phase 9: the library. A title, a product key, a searchable text column
-- with a full-text index, a favourite flag and a soft delete on generations.

-- AlterTable
ALTER TABLE "generations"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "productKey" TEXT,
  ADD COLUMN "searchText" TEXT,
  ADD COLUMN "favourite" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "generations_workspaceId_productKey_idx" ON "generations"("workspaceId", "productKey");

-- Full-text search over the flattened text. 'simple' rather than 'english':
-- product names are Yoruba, Igbo, Hausa, French and brand names, and a
-- stemmer that knows English would mangle them. Prefix matching (:*) in the
-- query does the forgiving part.
CREATE INDEX "generations_search_idx" ON "generations" USING GIN (to_tsvector('simple', coalesce("searchText", '')));
