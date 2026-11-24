const regexStarters = Object.freeze(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

const regexKeywords = Object.freeze(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const skipQuoted = (text, start) => {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
};

const skipTemplate = (text, start) => {
  let index = start + 1;
  while (index < text.length && text[index] !== "`") {
    if (text[index] === "\\") {
      index += 2;
    } else if (text[index] === "$" && text[index + 1] === "{") {
      index = skipExpression(text, index + 2);
    } else {
      index += 1;
    }
  }
  return index + 1;
};

const skipExpression = (text, start) => {
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(text, index);
    } else if (char === "`") {
      index = skipTemplate(text, index);
    } else {
      depth += char === "{" ? 1 : char === "}" ? -1 : 0;
      index += 1;
    }
  }
  return index;
};

const skipRegex = (text, start) => {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      break;
    }
    index += 1;
  }
  index += 1;
  while (/[a-z]/i.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
};

const startsRegex = (code) => {
  const trimmed = code.trimEnd();
  if (trimmed === "") {
    return true;
  }
  if (regexStarters.includes(trimmed[trimmed.length - 1])) {
    return true;
  }
  const word = trimmed.match(/[A-Za-z_$][\w$]*$/);
  return word !== null && regexKeywords.includes(word[0]);
};

export const analyze = (source) => {
  const comments = [];
  let code = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      comments.push({ line: lineOf(source, index), text: source.slice(index, stop) });
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      comments.push({ line: lineOf(source, index), text: source.slice(index, stop) });
      code += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (char === "'" || char === '"') {
      const stop = skipQuoted(source, index);
      code += `${char}${char}`;
      index = stop;
    } else if (char === "`") {
      const stop = skipTemplate(source, index);
      code += "``";
      code += source.slice(index, stop).replace(/[^\n]/g, "");
      index = stop;
    } else if (char === "/" && startsRegex(code)) {
      index = skipRegex(source, index);
      code += "/r/";
    } else {
      code += char;
      index += 1;
    }
  }
  return { code, comments };
};

const statementEnd = (code, start) => {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === ";" && depth === 0) {
      return index;
    }
  }
  return code.length;
};

export const topLevelConstants = (code) => {
  const found = [];
  const pattern = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const start = match.index + match[0].length;
    const end = statementEnd(code, start);
    found.push({ name: match[1], init: code.slice(start, end).trim(), line: lineOf(code, match.index) });
    pattern.lastIndex = end;
  }
  return found;
};

const countMembers = (text) => {
  let depth = 0;
  let members = 0;
  let pending = false;
  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      pending = true;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      members += pending ? 1 : 0;
      pending = false;
    } else if (!/\s/.test(char)) {
      pending = true;
    }
  }
  return members + (pending ? 1 : 0);
};

const hasTopLevelArrow = (text) => {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (depth === 0 && char === "=" && text[index + 1] === ">") {
      return true;
    }
  }
  return false;
};

export const classifyConstant = (init) => {
  if (/^(async\s+)?function\b/.test(init) || /^class\b/.test(init) || hasTopLevelArrow(init)) {
    return { kind: "definition" };
  }
  if (/^\(\s*(async\s*)?\(\s*\)\s*=>[\s\S]*\)\(\)$/.test(init)) {
    return { kind: "definition" };
  }
  const frozen = init.match(/^Object\.freeze\(\s*([\s\S]*)\)$/);
  if (frozen) {
    const body = frozen[1].trim();
    if (body.startsWith("{") || body.startsWith("[")) {
      const members = countMembers(body.slice(1, body.lastIndexOf(body.startsWith("{") ? "}" : "]")));
      return { kind: "group", members };
    }
  }
  return { kind: "value" };
};
