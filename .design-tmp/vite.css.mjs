import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
await build({configFile:false,root:process.cwd()+"/.design-tmp",logLevel:"warn",plugins:[tailwindcss()],build:{outDir:"out",emptyOutDir:true,cssCodeSplit:false,assetsInlineLimit:100000000,rollupOptions:{input:process.cwd()+"/.design-tmp/css-entry.html"}}});
