-- The live `memories` table is still vector(1536) from the pre-bge-m3 era.
-- 001_memories_table.sql already declares vector(1024) and carries the ALTER as
-- a comment, but the deployed table predates that file and the ALTER was never
-- run — so every insert has failed with "expected 1536 dimensions, not 1024"
-- since the embedding model moved to nv-embedqa-e5-v5 (1024 dims). The table is
-- empty as a result, which means the pgvector recall store chat searches has
-- silently returned nothing this whole time.
--
-- Safe to run as a plain ALTER: there are no rows to convert.

ALTER TABLE memories ALTER COLUMN embedding TYPE vector(1024);

-- The RPC's signature is dimension-typed too; recreate it so it matches.
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1024),
  match_google_id text,
  match_count int
)
RETURNS TABLE(id uuid, content text, similarity float)
LANGUAGE sql
AS $$
  SELECT id, content, 1 - (embedding <=> query_embedding) as similarity
  FROM memories
  WHERE google_id = match_google_id
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
