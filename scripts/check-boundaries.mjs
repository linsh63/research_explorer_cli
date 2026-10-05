#!/usr/bin/env node
import { readFileSync,readdirSync,statSync } from "node:fs";
import { join,relative,resolve } from "node:path";
const root=resolve("."),issues=[],pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8")),files=[];walk(join(root,"src"));
for(const path of files){const text=readFileSync(path,"utf8"),name=relative(root,path);for(const pattern of [/(?:auto-research-agent|research-explorer-core)\/(?:src|domain|application|infrastructure|core)/,/better-sqlite3/,/migrations\//,/\.research-data\/research\.db/])if(pattern.test(text))issues.push({file:name,reason:`forbidden internal dependency ${pattern}`});}
if(pkg.dependencies?.["@earendil-works/pi-coding-agent"]!=="1.0.2")issues.push({file:"package.json",reason:"Pi must be pinned exactly to audited 1.0.2"});
if(pkg.dependencies?.["@earendil-works/pi-tui"]!=="1.0.2")issues.push({file:"package.json",reason:"Pi TUI must match the pinned Pi version 1.0.2"});
const compatibility=pkg.researchExplorer?.compatibility;
if(compatibility?.pi!=="1.0.2"||compatibility?.coreService!=="1.0.0"||compatibility?.publicSchema!=="1.0.0")issues.push({file:"package.json",reason:"C0 compatibility declaration is missing or changed"});
for(const dependency of ["ink","react","blessed","commander","yargs"])if(pkg.dependencies?.[dependency])issues.push({file:"package.json",reason:`TUI/CLI reimplementation dependency forbidden: ${dependency}`});
if(pkg.bin?.rexplore!=="dist/launcher.js")issues.push({file:"package.json",reason:"rexplore binary boundary is missing"});
if(issues.length){console.error(JSON.stringify({status:"fail",issues},null,2));process.exit(1);}console.log(JSON.stringify({status:"pass",sourceFiles:files.length,piVersion:"1.0.2",binary:"rexplore"}));
function walk(directory){for(const name of readdirSync(directory)){const path=join(directory,name),stat=statSync(path);if(stat.isDirectory())walk(path);else if(path.endsWith(".ts"))files.push(path);}}
