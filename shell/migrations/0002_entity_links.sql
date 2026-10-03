-- Cross-tool links: any record in any tool can be linked to any record in another tool (a contact to a contract, a task to a
-- compliance item, ...). Tools address records as (tool id, record id); titles and URLs are resolved by the owning tool.
CREATE TABLE IF NOT EXISTS entity_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_tool   text NOT NULL,
  from_id     text NOT NULL,
  to_tool     text NOT NULL,
  to_id       text NOT NULL,
  kind        text NOT NULL DEFAULT 'related',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, from_tool, from_id, to_tool, to_id, kind)
);
CREATE INDEX IF NOT EXISTS entity_links_from ON entity_links (business_id, from_tool, from_id);
CREATE INDEX IF NOT EXISTS entity_links_to ON entity_links (business_id, to_tool, to_id);
