// worker 侧通用小工具（此前每个路由文件都各写一份 genId）
export function genId(): string { return crypto.randomUUID(); }
