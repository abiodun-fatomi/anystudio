-- The merchant shots: on a model, ghost mannequin, flat lay, pressed, studio,
-- recoloured, retouched, widened.
--
-- One capability with a `mode`, not eight capabilities: all eight are the same
-- vendor call with different fields, so eight rows here would be eight copies
-- of one adapter branch. The prices live in the seed (image.product_shot and
-- image.on_model), like every other price.
ALTER TYPE "ProviderCapability" ADD VALUE IF NOT EXISTS 'PRODUCT_SHOT' AFTER 'COLLAGE';
