const FORBIDDEN_KEYWORDS = new Set([
  'alter',
  'analyze',
  'begin',
  'call',
  'checkpoint',
  'cluster',
  'comment',
  'commit',
  'copy',
  'create',
  'deallocate',
  'delete',
  'discard',
  'do',
  'drop',
  'execute',
  'grant',
  'insert',
  'listen',
  'load',
  'lock',
  'merge',
  'notify',
  'prepare',
  'reassign',
  'refresh',
  'reindex',
  'release',
  'reset',
  'revoke',
  'rollback',
  'savepoint',
  'security',
  'set',
  'start',
  'truncate',
  'unlisten',
  'update',
  'vacuum'
]);

const SAFE_FUNCTIONS = new Set([
  'abs',
  'array_agg',
  'avg',
  'bool_and',
  'bool_or',
  'cardinality',
  'ceil',
  'ceiling',
  'coalesce',
  'concat',
  'concat_ws',
  'count',
  'date_trunc',
  'encode',
  'floor',
  'greatest',
  'json_agg',
  'json_build_array',
  'json_build_object',
  'jsonb_agg',
  'jsonb_build_array',
  'jsonb_build_object',
  'least',
  'length',
  'lower',
  'max',
  'min',
  'nullif',
  'pg_catalog.current_database',
  'pg_catalog.current_schema',
  'pg_catalog.current_schemas',
  'pg_catalog.has_schema_privilege',
  'pg_catalog.has_table_privilege',
  'pg_catalog.obj_description',
  'pg_catalog.pg_get_function_identity_arguments',
  'pg_catalog.pg_get_function_result',
  'pg_catalog.pg_get_functiondef',
  'pg_catalog.pg_get_userbyid',
  'pg_catalog.txid_current_if_assigned',
  'regexp_replace',
  'replace',
  'round',
  'string_agg',
  'substring',
  'sum',
  'to_char',
  'trim',
  'upper'
]);

const UNSAFE_FUNCTION_PATTERNS = [
  /^dblink/i,
  /^lo_/i,
  /^pg_advisory/i,
  /^pg_cancel_backend$/i,
  /^pg_create_/i,
  /^pg_logical_/i,
  /^pg_read_/i,
  /^pg_reload_conf$/i,
  /^pg_rotate_logfile$/i,
  /^pg_switch_wal$/i,
  /^pg_terminate_backend$/i,
  /^pg_write_/i,
  /^set_config$/i
];

function sqlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isIdentifierStart(character) {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

export function tokenizeReadonlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw sqlError('SQL_EMPTY');
  const tokens = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw sqlError('SQL_UNTERMINATED_COMMENT');
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      if (sql[index - 1] !== "'") throw sqlError('SQL_UNTERMINATED_STRING');
      tokens.push({ type: 'literal', value: '<literal>' });
      continue;
    }
    if (character === '"') {
      let value = '';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          break;
        } else {
          value += sql[index];
          index += 1;
        }
      }
      if (sql[index - 1] !== '"') throw sqlError('SQL_UNTERMINATED_IDENTIFIER');
      tokens.push({ type: 'identifier', value, quoted: true });
      continue;
    }
    if (character === '$') {
      const parameter = /^\$(\d+)/.exec(sql.slice(index));
      if (parameter) {
        tokens.push({ type: 'parameter', value: Number(parameter[1]) });
        index += parameter[0].length;
        continue;
      }
      if (/^\$[A-Za-z0-9_]*\$/.test(sql.slice(index))) {
        throw sqlError('SQL_DOLLAR_QUOTE_REJECTED');
      }
      throw sqlError('SQL_UNRECOGNIZED_DOLLAR_TOKEN');
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && isIdentifierPart(sql[index])) index += 1;
      tokens.push({ type: 'identifier', value: sql.slice(start, index).toLowerCase(), quoted: false });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(sql.slice(index));
      tokens.push({ type: 'number', value: number[0] });
      index += number[0].length;
      continue;
    }
    const two = sql.slice(index, index + 2);
    if (['::', '<=', '>=', '<>', '!=', '||', '->', '#>'].includes(two)) {
      tokens.push({ type: 'symbol', value: two });
      index += 2;
      continue;
    }
    if ('(),.*=<>+-/%[]:'.includes(character)) {
      tokens.push({ type: 'symbol', value: character });
      index += 1;
      continue;
    }
    if (character === ';') throw sqlError('SQL_SEMICOLON_REJECTED');
    throw sqlError('SQL_UNRECOGNIZED_TOKEN');
  }
  return tokens;
}

function functionNames(tokens) {
  const names = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'identifier') continue;
    if (tokens[index - 1]?.value === '.') continue;
    let cursor = index;
    const parts = [tokens[cursor].value];
    while (
      tokens[cursor + 1]?.value === '.' &&
      tokens[cursor + 2]?.type === 'identifier'
    ) {
      parts.push(tokens[cursor + 2].value);
      cursor += 2;
    }
    if (tokens[cursor + 1]?.value === '(') {
      const name = parts.join('.');
      if (!['cast', 'extract', 'grouping', 'position', 'row', 'trim'].includes(name)) names.push(name);
    }
  }
  return [...new Set(names)];
}

export function validateReadonlySql(sql) {
  const tokens = tokenizeReadonlySql(sql);
  const words = tokens.filter((token) => token.type === 'identifier' && !token.quoted).map((token) => token.value);
  if (!['select', 'with'].includes(words[0])) throw sqlError('SQL_ROOT_NOT_READONLY_QUERY');

  const forbidden = words.find((word) => FORBIDDEN_KEYWORDS.has(word));
  if (forbidden) throw sqlError('SQL_FORBIDDEN_OPERATION');
  if (words.includes('into')) throw sqlError('SQL_SELECT_INTO_REJECTED');
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === 'for' && ['update', 'share', 'key'].includes(words[index + 1])) {
      throw sqlError('SQL_ROW_LOCK_REJECTED');
    }
  }

  const calls = functionNames(tokens);
  for (const call of calls) {
    const leaf = call.split('.').at(-1);
    if (UNSAFE_FUNCTION_PATTERNS.some((pattern) => pattern.test(call) || pattern.test(leaf))) {
      throw sqlError('SQL_UNSAFE_FUNCTION_REJECTED');
    }
    if (!SAFE_FUNCTIONS.has(call) && !SAFE_FUNCTIONS.has(leaf)) {
      throw sqlError('SQL_UNKNOWN_FUNCTION_REJECTED');
    }
  }

  const parameters = tokens
    .filter((token) => token.type === 'parameter')
    .map((token) => token.value);
  if (parameters.some((value) => value < 1 || !Number.isSafeInteger(value))) {
    throw sqlError('SQL_PARAMETER_INDEX_INVALID');
  }
  const uniqueParameters = [...new Set(parameters)].sort((left, right) => left - right);
  for (let index = 0; index < uniqueParameters.length; index += 1) {
    if (uniqueParameters[index] !== index + 1) throw sqlError('SQL_PARAMETER_SEQUENCE_INVALID');
  }
  return Object.freeze({ parameterCount: uniqueParameters.length, functionNames: Object.freeze(calls) });
}
