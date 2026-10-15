// Confere se os content scripts convivem: `node checar.js` dentro de extensao/.
//
// Os três rodam no mesmo world e dividem o escopo global. Um `const` com o
// mesmo nome em dois arquivos derruba o segundo com SyntaxError — e o sintoma
// não aponta para a causa: o painel simplesmente não aparece.

const fs = require("fs");
const path = require("path");

const AQUI = __dirname;
const CONTENT = ["content.js", "overlay.js", "painel.js"];
const TODOS = ["background.js", "popup.js", "hook.js", ...CONTENT];
const RE_TOPO = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

let problemas = 0;

for (const arquivo of TODOS) {
  const src = fs.readFileSync(path.join(AQUI, arquivo), "utf8");
  try {
    new Function(src);
  } catch (e) {
    console.log(`SINTAXE  ${arquivo}: ${e.message}`);
    problemas++;
  }
}

const donos = new Map();
for (const arquivo of CONTENT) {
  const src = fs.readFileSync(path.join(AQUI, arquivo), "utf8");
  for (const m of src.matchAll(RE_TOPO)) {
    const lista = donos.get(m[1]) || [];
    if (!lista.includes(arquivo)) lista.push(arquivo);
    donos.set(m[1], lista);
  }
}

for (const [nome, arquivos] of donos) {
  if (arquivos.length > 1) {
    console.log(`COLISÃO  "${nome}" declarado em ${arquivos.join(" e ")}`);
    problemas++;
  }
}

try {
  new Function(CONTENT.map((a) => fs.readFileSync(path.join(AQUI, a), "utf8")).join("\n;\n"));
} catch (e) {
  console.log(`ESCOPO   os content scripts juntos não parseiam: ${e.message}`);
  problemas++;
}

console.log(problemas ? `\n${problemas} problema(s)` : "tudo certo: sintaxe ok e sem colisão de nomes");
process.exit(problemas ? 1 : 0);
