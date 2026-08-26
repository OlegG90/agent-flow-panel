import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", ".pi/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
