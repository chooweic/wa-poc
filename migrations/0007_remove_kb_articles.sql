-- One knowledge base only: transaction types and their reasons. The agent
-- answers from the transaction types' general guides and the reasons'
-- guides; free-standing articles are no longer used. (The original demo
-- articles are in 0002_seed_kb.sql, if their text is ever wanted again: it can
-- be pasted into a transaction type's general guide.)
DROP TABLE IF EXISTS kb_articles;
