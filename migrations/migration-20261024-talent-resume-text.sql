-- 人才库：保存招聘平台同步过来的简历原文
--
-- 为什么不复用 notes：接口层对 notes 做了 cleanText(body.notes, 2000) 截断，
-- 而一份在线简历通常 1500-4000 字，超出部分会静默丢失。
-- 为什么不走 resume_url 文件链路：那条链路只接受 .pdf / .docx（见 src/worker/docText.ts），
-- 而浏览器插件从 BOSS 直聘抓到的是 DOM 文本，没有原始文件可上传。
ALTER TABLE talents ADD COLUMN resume_text TEXT;
