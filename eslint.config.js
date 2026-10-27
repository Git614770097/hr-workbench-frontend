// ESLint 扁平配置（ESLint 9）
//
// 目标**不是**统一代码风格——那需要 prettier + 全量格式化，会在一个 4 万行的仓库里
// 制造几万行无意义的 diff，review 时真正的问题反而被淹没。这里只开三条能抓「真 bug」的规则：
// 宁可三条全绿，也不要一百条全黄（后者等于没有护栏，人两天就学会无视它）。
//
// 三条的分工：
//   no-floating-promises      忘记 await 的写操作。审批流里「接口没报错、状态没变」的
//                             那类 bug 基本都是它。**必须**开类型感知才能判断。
//   react-hooks/exhaustive-deps  闭包捕获了旧的 state / props。表现为「点了没反应」
//                             或「数据是上一次的」，人肉 review 极难看出来。
//   no-explicit-any           先把 149 处 any 标成 warn 当雷达用，不阻断构建。
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "backups/**",
      "outputs/**",
      "_promo/**",
      "_shots/**",
      "public/**",
      "scripts/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // 类型感知 lint：no-floating-promises 要靠类型信息才知道「这个表达式是个被丢掉的 Promise」。
        // projectService 会自动找到 tsconfig.json，不用手写 project 数组。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // 后端单独收紧：这里「忘 await」的代价是**静默丢写**——接口返回 200、数据没落库，
  // 前端看不到任何异常，等发现时已经错了好几天。而前端那边的 159 条绝大多数是
  // `useEffect(() => { load(); }, [load])` 这种 fire-and-forget 加载，内部自带 try/catch，
  // 危害等级完全不同。所以同一条规则在两侧用不同级别，而不是一刀切。
  //
  // 现在 worker 是 0 命中，设成 error 不会挡住任何人；它的作用是**守住增量**：
  // 以后任何一次漏掉 await 的 DB 写 / 审计写，提交当场变红。
  {
    files: ["src/worker/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  }
);
