-- 用户自有 AI Key（BYOK）：AI 配额用完时用户可填自己的 DeepSeek Key 继续用。
-- ai_key 存 AES-GCM 密文（主密钥为 wrangler secret AI_KEY_SECRET），不明文落库；
-- ai_key_masked 存展示用掩码（如 sk-****abcd），读取展示不依赖解密。
ALTER TABLE users ADD COLUMN ai_key TEXT;
ALTER TABLE users ADD COLUMN ai_key_masked TEXT;
