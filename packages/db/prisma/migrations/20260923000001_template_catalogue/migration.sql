-- The template catalogue: settings a seller picks by looking at a rendered
-- example of one. A table rather than a constant because the tile is a
-- photograph, and photographs are produced, reviewed and replaced by
-- operators rather than by releases.
CREATE TABLE "templates" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'scene',
    "params" JSONB NOT NULL,
    "thumbnailKey" TEXT,
    "swatch" JSONB NOT NULL,
    "keywords" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 100,
    -- Once true, the seed stops overwriting this row's copy and prompt.
    "operatorEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("code")
);

-- The picker reads one category at a time, in catalogue order.
CREATE INDEX "templates_category_sort_idx" ON "templates"("category", "sort");
