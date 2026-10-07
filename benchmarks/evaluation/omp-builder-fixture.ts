export const ompBuilderPrompt =
	"Update this small TypeScript/Python pricing project. Rename the exported subtotal function to sumPrices and update all callers. Move src/ledger.ts to src/pricing.ts and update imports. Consolidate and sort imports in src/client.ts. Fix percentage-discount arithmetic in both TypeScript total and Python net_total: discount_percent is a percentage, not a fraction. Preserve ordinary arithmetic for numeric prices and percentage values, including values outside 0–100; do not add clamping or rounding. Keep the unrelated helper bodies unchanged. Do not change project configuration or checks. Run npm test and inspect the complete diff before finishing. Do not commit, push, publish or delegate this evaluation task.";

export function ompBuilderFiles() {
	const helperBody = Array.from(
		{ length: 14 },
		(_, i) => `  const item${i} = value + ${i};`,
	).join("\n");
	const helpers = Array.from(
		{ length: 40 },
		(_, i) =>
			`export function helper${i}(value: number): number {\n${helperBody}\n  return item13;\n}\n`,
	).join("\n");
	return {
		"AGENTS.md":
			"Read existing source before changing it. Preserve public signatures except the explicitly requested rename and preserve unrelated code. Do not edit package.json, check.cjs, .gitignore or tsconfig.json. Run npm test after changes. Do not publish.\n",
		".gitignore": "node_modules/\n.build/\n__pycache__/\ntools/__pycache__/\n",
		"package.json":
			'{"name":"omp-builder-fixture","private":true,"scripts":{"test":"node check.cjs"}}\n',
		"tsconfig.json":
			'{"compilerOptions":{"strict":true,"module":"commonjs","target":"ES2022"},"include":["src/*.ts"]}\n',
		"src/ledger.ts": `export function subtotal(prices: readonly number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0);\n}\n\nexport function total(prices: readonly number[], discount_percent: number): number {\n  return subtotal(prices) * (1 - discount_percent);\n}\n\n${helpers}`,
		"src/client.ts":
			'import { total } from "./ledger";\nimport { subtotal } from "./ledger";\nexport function invoice(prices: readonly number[], discount: number) {\n  return {base: subtotal(prices), net: total(prices, discount)};\n}\n',
		"src/report.ts":
			'import { subtotal, total } from "./ledger";\nexport function report(prices: readonly number[], discount: number) {\n  return [subtotal(prices), total(prices, discount)];\n}\n',
		"tools/pricing.py":
			"def net_total(prices, discount_percent):\n    return sum(prices) * (1 - discount_percent)\n",
		"check.cjs": String.raw`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript'),cp=require('node:child_process');
fs.mkdirSync('.build',{recursive:true});
for(const name of fs.readdirSync('src').filter(name=>name.endsWith('.ts')))fs.writeFileSync(path.join('.build',name.replace(/\.ts$/,'.js')),ts.transpileModule(fs.readFileSync(path.join('src',name),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
assert.equal(require('./.build/client.js').invoice([40,60],20).net,80);
const value=cp.execFileSync('python3',['-c','from tools.pricing import net_total; print(net_total([40,60],20))'],{encoding:'utf8'});
assert.equal(Number(value.trim()),80);console.log('Public pricing checks passed');
`,
	};
}

export const ompBuilderAllowedPaths = [
	"src/ledger.ts",
	"src/pricing.ts",
	"src/client.ts",
	"src/report.ts",
	"tools/pricing.py",
];

// Held only by the operator. Neither model receives this verifier or its hidden cases.
export const ompBuilderVerifier = String.raw`
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),ts=require('/node_modules/typescript');
const root='/workspace',out='/tmp/compiled';fs.mkdirSync(out,{recursive:true});
assert.equal(fs.existsSync(root+'/src/ledger.ts'),false);assert.equal(fs.existsSync(root+'/src/pricing.ts'),true);
for(const name of fs.readdirSync(root+'/src').filter(name=>name.endsWith('.ts')))fs.writeFileSync(path.join(out,name.replace(/\.ts$/,'.js')),ts.transpileModule(fs.readFileSync(path.join(root,'src',name),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
const program=ts.createProgram(fs.readdirSync(root+'/src').filter(name=>name.endsWith('.ts')).map(name=>root+'/src/'+name),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,strict:true,noEmit:true});assert.equal(ts.getPreEmitDiagnostics(program).length,0);
const pricing=require(out+'/pricing.js'),client=require(out+'/client.js'),report=require(out+'/report.js');
assert.equal(typeof pricing.sumPrices,'function');assert.equal(pricing.subtotal,undefined);
for(const name of ['client.ts','report.ts'])assert.equal(fs.readFileSync(root+'/src/'+name,'utf8').includes('./ledger'),false);
const cases=[{prices:[],discount:0},{prices:[40,60],discount:20},{prices:[1.25,2.75],discount:100},{prices:[-5,10],discount:-10},{prices:[0.1,0.2],discount:125},{prices:[2,7,11],discount:33}];
let assertions=6;
for(const item of cases){const base=item.prices.reduce((sum,value)=>sum+value,0),expected=base*(1-item.discount/100);for(const value of [pricing.sumPrices(item.prices)-base,pricing.total(item.prices,item.discount)-expected,client.invoice(item.prices,item.discount).base-base,client.invoice(item.prices,item.discount).net-expected,report.report(item.prices,item.discount)[0]-base,report.report(item.prices,item.discount)[1]-expected]){assert.ok(Math.abs(value)<1e-9);assertions++;}}
for(let i=0;i<40;i++){assert.equal(pricing['helper'+i](7),20);const source=fs.readFileSync(root+'/src/pricing.ts','utf8');const expected='export function helper'+i+'(value: number): number {\n'+Array.from({length:14},(_,j)=>'  const item'+j+' = value + '+j+';').join('\n')+'\n  return item13;\n}';assert.ok(source.includes(expected));assertions++;}
const python='import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("pricing","/workspace/tools/pricing.py")\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\ncases=json.loads(sys.argv[1])\nfor item in cases:\n expected=sum(item["prices"])*(1-item["discount"]/100)\n assert abs(m.net_total(item["prices"],item["discount"])-expected)<1e-9\n';
cp.execFileSync('python3',['-c',python,JSON.stringify(cases)],{env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});assertions+=cases.length;
const source=ts.createSourceFile('client.ts',fs.readFileSync(root+'/src/client.ts','utf8'),ts.ScriptTarget.Latest,true);const imports=source.statements.filter(ts.isImportDeclaration);assert.equal(imports.length,1);const names=imports[0].importClause.namedBindings.elements.map(item=>item.name.text);assert.deepEqual(names,[...names].sort());assertions+=2;
assert.equal(process.env.FREESTYLE_API_KEY,undefined);assert.equal(fs.existsSync('/workspace/.git'),false);assertions+=2;
console.log(JSON.stringify({passed:true,assertions}));
`;
