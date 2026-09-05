-- Phase 10: the music genre and voice catalogues.

CREATE TABLE "music_genres" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "promptHints" TEXT NOT NULL,
    "bpmMin" INTEGER,
    "bpmMax" INTEGER,
    "languages" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "music_genres_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "music_genres_family_sort_idx" ON "music_genres"("family", "sort");

CREATE TABLE "voice_profiles" (
    "key" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerVoiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "accent" TEXT,
    "gender" TEXT,
    "tags" TEXT[],
    "sampleUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "voice_profiles_language_sort_idx" ON "voice_profiles"("language", "sort");
