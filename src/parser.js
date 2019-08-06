/* eslint-disable no-bitwise */
const BN = require('bn.js');
const path = require('path');
const fs = require('fs');

const grammar = require('./grammar/grammar');
const inputMaps = require('./inputMap/inputMap');
const regex = require('./utils/regex');
const {
    formatEvenBytes,
    toHex,
    padNBytes,
    normalize,
    sliceCommasIgnoringTemplates,
} = require('./utils');

const { opcodes } = require('./opcodes/opcodes');

const TYPES = {
    OPCODE: 'OPCODE',
    PUSH: 'PUSH',
    JUMPDEST: 'JUMPDEST',
    PUSH_JUMP_LABEL: 'PUSH_JUMP_LABEL',
    MACRO: 'MACRO',
    TEMPLATE: 'TEMPLATE',
    CODESIZE: 'CODESIZE',
    TABLE_START_POSITION: 'TABLE_START_POSITION',
};

const CONTEXT = {
    NONE: 1,
    MACRO: 2,
};

/**
 * Throw error if condition is not met (does not evaluate true)
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

/**
 * Generate a string from debug info that gives location in file of an error.
 * @param debug
 * @returns {string}
 */
function debugLocationString(debug) {
    return `Error in Huff code was traced to line ${debug.lineNumber} in file ${debug.filename}.`;
}


const parser = {};

/**
 * Generate random 5 byte (i.e. 10 character) hexadecimal number for use as an id
 * @returns {string}
 */
parser.getId = () => {
    return [...new Array(10)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
};

parser.substituteTemplateArguments = (newTemplateArguments, templateRegExps) => {
    return newTemplateArguments.map(arg => templateRegExps
        .reduce((acc, { pattern, value }) => acc
            .replace(pattern, value), arg), []);
};


/**
 * Process a numeric or template literal. If string/int matches a number (dec or hex), in which case it returns a BN
 * representation of that number. Otherwise error.
 * @param literal
 */
parser.processMacroOrNumericOrTemplateLiteral = (literal, macros) => {
    if (literal.match(grammar.macro.LITERAL_HEX)) {
        return new BN(literal.match(grammar.macro.LITERAL_HEX)[1], 16);
    }
    if (literal.match(grammar.macro.LITERAL_DECIMAL)) {
        return new BN(literal.match(grammar.macro.LITERAL_DECIMAL)[1], 10);
    }
    if (literal.match(grammar.macro.TEMPLATE)) {
        const token = literal.match(grammar.macro.TEMPLATE);
        return parser.processTemplateLiteral(token[1]);
    }
    if (macros[literal]) {
        check(
            macros[literal].ops.length === 1 && macros[literal].ops[0].type === TYPES.PUSH,
            `cannot add ${literal}, ${macros[literal].ops} not a literal`
        );
        return new BN(macros[literal].ops[0].args[0], 16);
    }
    throw new Error(`I don't know how to process literal "${literal}" as a numeric or template literal`);
};

/**
 * Process a numeric literal. If string/int matches a number (dec or hex), in which case it returns a BN representation
 * of that number. Otherwise error.
 * @param literal
 */
parser.processNumericLiteral = (literal) => {
    if (literal.match(grammar.macro.LITERAL_HEX)) {
        return new BN(literal.match(grammar.macro.LITERAL_HEX)[1], 16);
    }
    if (literal.match(grammar.macro.LITERAL_DECIMAL)) {
        return new BN(literal.match(grammar.macro.LITERAL_DECIMAL)[1], 10);
    }
    throw new Error(`I don't know how to process literal "${literal}" as a number literal`);
};

/**
 * Process a literal from a macro. First sees if string/int matches a number (dec or hex), in which case it returns a
 * BN representation of that number, and if not sees if it is an opcode. Otherwise error.
 * @param op
 * @param macros
 */
parser.processMacroLiteral = (op, macros) => {
    if (op.match(grammar.macro.LITERAL_HEX)) {
        return new BN(op.match(grammar.macro.LITERAL_HEX)[1], 16);
    }
    if (op.match(grammar.macro.LITERAL_DECIMAL)) {
        return new BN(op.match(grammar.macro.LITERAL_DECIMAL)[1], 10);
    }
    // TODO: is this needed? It converts opcodes weirdly
    if (macros[op]) {
        check(
            macros[op].ops.length === 1 && macros[op].ops[0].type === TYPES.PUSH,
            `cannot add ${op}, ${macros[op].ops} not a literal`
        );
        return new BN(macros[op].ops[0].args[0], 16);
    }
    throw new Error(`I don't know how to process literal "${op}" as a macro literal`);
};

/**
 * Unpicks template parameters with arithmetic like <dup1+3> and <swap16-0x05>
 * @param literal A literal taking the form of a stack opcode (dup or swap) followed by some add/sub arithmetic on dec
 *     or hex numbers e.g. dup1+3 and swap16-0x05
 * @returns {*} A literal with the arithmetic folded to form one constant. Errors if that opcode does not exist.
 */
parser.processModifiedOpcode = (literal) => {
    function doArithmeticOperation(a, b, operation) {
        let result;
        switch (operation) {
            case '+':
                result = a.add(b);
                break;
            case '-':
                result = a.sub(b);
                break;
            default:
                throw new Error(`unrecognised arithmetic operation "${operation}". Should be either + or -.`);
        }
        return result;
    }

    const arithmeticStackOpcodeRegex = new RegExp('\\s*(dup|swap)(0x[0-9a-fA-F]+|\\d+)([+\\-])(0x[0-9a-fA-F]+|\\d+)\\s*');
    const regexMatchForParameterArithmetic = literal.match(arithmeticStackOpcodeRegex);
    let stackOpcodeType;
    let firstNumber;
    let operation;
    let secondNumber;
    try {
        [, stackOpcodeType, firstNumber, operation, secondNumber] = regexMatchForParameterArithmetic;
    } catch (error) {
        throw new Error(`failed to process literal "${literal}"` + error.toString());
    }
    firstNumber = parser.processNumericLiteral(firstNumber);
    secondNumber = parser.processNumericLiteral(secondNumber);
    const finalNumber = doArithmeticOperation(firstNumber, secondNumber, operation);
    // TODO: is this check neccesary? What if opcode arithmetic is nested?
    if (finalNumber < 1 || finalNumber > 16) {
        throw new Error(`result of arithmetic operation ${firstNumber}${operation}${secondNumber} is ${finalNumber} `
            + 'but must be between 1 and 16 inclusive');
    }
    return opcodes[stackOpcodeType + finalNumber.toString()];
};

parser.processTemplateLiteral = (literal, macros) => {
    function parseLiteral(rawOp) {
        const op = regex.removeSpacesAndLines(rawOp);
        if (regex.containsOperatorsAndIsNotStackOp(op)) {
            return parser.processTemplateLiteral(op, macros);
        }
        return parser.processMacroOrNumericOrTemplateLiteral(op, macros);
    }

    if (literal.includes('-')) {
        return normalize(literal.split('-').map(parseLiteral).reduce((acc, val) => {
            if (!acc) {
                return val;
            }
            return acc.sub(val);
        }, null));
    }
    if (literal.includes('+')) {
        return normalize(literal.split('+').map(parseLiteral).reduce((acc, val) => {
            if (!acc) {
                return val;
            }
            return acc.add(val);
        }, null));
    }
    if (literal.includes('*')) {
        return normalize(literal.split('*').map(parseLiteral).reduce((acc, val) => {
            if (!acc) {
                return val;
            }
            return acc.mul(val);
        }, null));
    }
    return parser.processMacroLiteral(literal, macros);
};

parser.parseTemplate = (templateName, macros = {}, index = 0, debug = {}) => {
    const macroId = parser.getId();
    const inlineTemplateName = `inline-${templateName}-${macroId}`;
    let opsType = '';
    let opsValue = '';
    let opsArgs = [];
    let name = templateName;
    if (regex.isLiteral(templateName)) {
        const hex = formatEvenBytes(parser.processTemplateLiteral(templateName, macros).toString(16));
        const opcode = toHex(95 + (hex.length / 2));
        opsType = TYPES.PUSH;
        opsValue = opcode;
        opsArgs = [hex];
        name = inlineTemplateName;
    } else if (regex.isModifiedOpcode(templateName)) {
        const opcode = parser.processModifiedOpcode(templateName, macros).toString(16);
        opsType = TYPES.OPCODE;
        opsValue = opcode;
    } else if (opcodes[templateName]) {
        opsType = TYPES.OPCODE;
        opsValue = opcodes[templateName];
    } else if (macros[templateName]) {
        return {
            macros,
            templateName,
        };
    } else if (templateName.match(grammar.macro.TEMPLATE)) {
        const token = templateName.match(grammar.macro.TEMPLATE);
        opsType = TYPES.TEMPLATE;
        // eslint-disable-next-line prefer-destructuring
        opsValue = token[1];
    } else {
        opsType = TYPES.PUSH_JUMP_LABEL;
        opsValue = templateName;
    }
    return {
        templateName: inlineTemplateName,
        macros: {
            ...macros,
            [inlineTemplateName]: {
                name,
                ops: [{
                    type: opsType,
                    value: opsValue,
                    args: opsArgs,
                    index,
                    debug,
                }],
                templateParams: [],
            },
        },
    };
};

parser.processMacro = (
    name,
    startingBytecodeIndex = 0,
    templateArgumentsRaw = [],
    startingMacros = {},
    map = {},
    jumptables = {}
) => {
    const result = parser.processMacroInternal(name, startingBytecodeIndex, templateArgumentsRaw, startingMacros, map);
    if (result.unmatchedJumps.length > 0) {
        let errorString = `originating macro ${name}, unknown jump labels/opcodes/template parameters, cannot compile. `
        + 'Possibly forgot parentheses in macro call, undefined jump labels, or a misspelled label/opcode? '
            + '(NB possibly substituted as a template parameter):';
        result.unmatchedJumps.forEach((unmatchedJump) => {
            errorString += `\n"${unmatchedJump.label}". ` + debugLocationString(unmatchedJump.debug);
        }); // NB currently not using bytecodeIndex or lineIndex but they might be useful
        throw new Error(errorString);
    }

    let tableOffset = (result.data.bytecode.length / 2);
    let { bytecode } = result.data;
    const jumpkeys = Object.keys(jumptables);
    const tableOffsets = {};
    if (jumpkeys.length > 0) {
        bytecode += '00';
    }
    jumpkeys.forEach((jumpkey) => {
        const jumptable = jumptables[jumpkey];
        let tablecode;
        if (jumptable.table.jumps) {
            tableOffsets[jumptable.name] = tableOffset;
            tableOffset += jumptable.table.size;
            tablecode = jumptable.table.jumps.map((jumplabel) => {
                if (!result.jumpindices[jumplabel]) {
                    return '';
                }
                const offset = result.jumpindices[jumplabel];
                const hex = formatEvenBytes(toHex(offset));
                if (!jumptable.table.compressed) {
                    return padNBytes(hex, 0x20);
                }
                return hex;
            }).join('');
        } else {
            tablecode = jumptable.table.table;
            tableOffsets[jumptable.name] = tableOffset;
            tableOffset += jumptable.table.size;
        }
        bytecode += tablecode;
    });
    result.tableInstances.forEach((tableInstance) => {
        if (!tableOffsets[tableInstance.label]) {
            throw new Error(`expected to find ${tableInstance.label} in ${JSON.stringify(tableOffsets)}`);
        }
        const { offset } = tableInstance;
        if (bytecode.slice((offset * 2) + 2, (offset * 2) + 6) !== 'xxxx') {
            throw new Error(`expected ${tableInstance.offset} to be xxxx`);
        }
        const pre = bytecode.slice(0, (offset * 2) + 2);
        const post = bytecode.slice((offset * 2) + 6);
        bytecode = `${pre}${formatEvenBytes(toHex(tableOffsets[tableInstance.label]))}${post}`;
    });
    return {
        ...result,
        data: {
            ...result.data,
            bytecode,
        },
    };
};

parser.processMacroInternal = (
    name,
    startingBytecodeIndex = 0,
    templateArgumentsRaw = [],
    startingMacros = {},
    map = {},
    jumpindicesInitial = {},
    tableInstancesInitial = []
) => {
    let macros = startingMacros;
    const macro = macros[name];
    check(macro, `expected ${name} to exist!`);
    const {
        ops,
        templateParams,
    } = macro;

    const templateArguments = templateArgumentsRaw.reduce((a, t) => [...a, ...sliceCommasIgnoringTemplates(t)], []);
    let extraErrorString = '';
    if (macro.ops[0] && macro.ops[0].debug) {
        extraErrorString = ' ' + debugLocationString(macro.ops[0].debug);
    }
    check(templateParams.length === templateArguments.length, `macro ${name} has invalid templated inputs! `
        + 'This likely means you have supplied the wrong number of parameters to the macro call.'
        + extraErrorString);
    const templateRegExps = templateParams.map((label, i) => {
        const pattern = new RegExp(`\\b(${label})\\b`, 'g');
        const value = templateArguments[i];
        return { pattern, value };
    });

    const jumptable = [];
    let jumpindices = {};
    let tableInstances = [...tableInstancesInitial];
    let offset = startingBytecodeIndex;
    const codes = ops.map((op, index) => {
        switch (op.type) {
            case TYPES.MACRO: {
                const args = parser.substituteTemplateArguments(op.args, templateRegExps);
                const result = parser.processMacroInternal(op.value, offset, args, macros, map, jumpindicesInitial, []);
                tableInstances = [...tableInstances, ...result.tableInstances];
                jumptable[index] = result.unmatchedJumps;
                jumpindices = { ...jumpindices, ...result.jumpindices };
                offset += (result.data.bytecode.length / 2);
                result.data.debug = op.debug;
                return result.data;
            }
            case TYPES.TEMPLATE: {
                const macroNameIndex = templateParams.indexOf(op.value);
                check(index !== -1, `cannot find template ${op.value}`);
                // what is this template? It's either a macro or a template argument;
                let templateParameterValue = templateArguments[macroNameIndex];
                // Get the value of the template parameter to replace with. op.value is the name of the template
                // parameter, and parsedName the value
                const parsedName = parser.substituteTemplateArguments([op.value], templateRegExps);
                // If multiple parameters match, which really shouldn't happen
                if (parsedName.length !== 1) {
                    throw new Error('cannot parse template invokation ', parsedName);
                }
                let nameToUse = parsedName[0];
                let templateArgs = [];
                const token = (nameToUse + '()').match(grammar.macro.MACRO_CALL);
                if (token) {
                    // eslint-disable-next-line prefer-destructuring
                    nameToUse = token[1];
                    templateArgs = token[2] ? [token[2]] : [];
                }
                ({
                    macros,
                    templateName: templateParameterValue,
                } = parser.parseTemplate(nameToUse, macros, index, op.debug));
                const result = parser.processMacroInternal(templateParameterValue, offset, templateArgs, macros, map,
                    jumpindicesInitial, []);
                tableInstances = [...tableInstances, ...result.tableInstances];
                jumptable[index] = result.unmatchedJumps;
                jumpindices = { ...jumpindices, ...result.jumpindices };
                offset += (result.data.bytecode.length / 2);
                result.data.debug = op.debug;
                return result.data;
            }
            case TYPES.CODESIZE: {
                check(index !== -1, `cannot find macro ${op.value}`);
                const result = parser.processMacroInternal(op.value, offset, op.args, macros, map, jumpindicesInitial, []);
                const hex = formatEvenBytes((result.data.bytecode.length / 2).toString(16));
                const opcode = toHex(95 + (hex.length / 2));
                const bytecode = `${opcode}${hex}`;
                offset += (bytecode.length / 2);
                return {
                    bytecode: `${opcode}${hex}`,
                    sourcemap: [inputMaps.getFileLine(op.index, map)],
                };
            }
            case TYPES.OPCODE: {
                offset += 1;
                return {
                    bytecode: op.value,
                    sourcemap: [inputMaps.getFileLine(op.index, map)],
                };
            }
            case TYPES.PUSH: {
                check(op.args.length === 1, `wrong argument count for PUSH, ${JSON.stringify(op)}`);
                const codebytes = 1 + (op.args[0].length / 2);
                const sourcemap = [inputMaps.getFileLine(op.index, map)];
                offset += codebytes;
                return {
                    bytecode: `${op.value}${op.args[0]}`,
                    sourcemap: [...new Array(codebytes)].map(() => sourcemap),
                };
            }
            case TYPES.PUSH_JUMP_LABEL: {
                jumptable[index] = [{ label: op.value, bytecodeIndex: 0, debug: op.debug }];
                const sourcemap = inputMaps.getFileLine(op.index, map);
                offset += 3;
                return {
                    bytecode: `${opcodes.push2}xxxx`,
                    sourcemap: [sourcemap, sourcemap, sourcemap],
                };
            }
            case TYPES.TABLE_START_POSITION: {
                tableInstances.push({ label: op.value, offset });
                const sourcemap = inputMaps.getFileLine(op.index, map);
                offset += 3;
                return {
                    bytecode: `${opcodes.push2}xxxx`,
                    sourcemap: [sourcemap, sourcemap, sourcemap],
                };
            }
            case TYPES.JUMPDEST: {
                jumpindices[op.value] = offset;
                offset += 1;
                return {
                    bytecode: opcodes.jumpdest,
                    sourcemap: [inputMaps.getFileLine(op.index, map)],
                };
            }
            default: {
                check(false, `could not interpret op ${JSON.stringify(op)}. ` + debugLocationString(op.debug));
                return null;
            }
        }
    });
    let runningIndex = startingBytecodeIndex;
    const codeIndices = codes.map(({ bytecode }) => {
        const old = runningIndex;
        runningIndex += bytecode.length / 2;
        return old;
    });
    const unmatchedJumps = [];

    // for every jump label, I need to get the absolute bytecode index
    const data = codes.reduce((acc, { bytecode, sourcemap }, index) => {
        let formattedBytecode = bytecode;
        if (jumptable[index]) {
            const jumps = jumptable[index];
            // eslint-disable-next-line no-restricted-syntax
            for (const { label: jumplabel, bytecodeIndex, debug } of jumps) {
                // eslint-disable-next-line no-prototype-builtins
                if (jumpindices.hasOwnProperty(jumplabel)) {
                    const jumpvalue = padNBytes(toHex(jumpindices[jumplabel]), 2);
                    const pre = formattedBytecode.slice(0, bytecodeIndex + 2);
                    const post = formattedBytecode.slice(bytecodeIndex + 6);
                    if (formattedBytecode.slice(bytecodeIndex + 2, bytecodeIndex + 6) !== 'xxxx') {
                        throw new Error(
                            `expected indices ${bytecodeIndex + 2} to ${bytecodeIndex + 6} to be jump location, of
                            ${formattedBytecode}`
                        );
                    }
                    formattedBytecode = `${pre}${jumpvalue}${post}`;
                } else {
                    const jumpOffset = (codeIndices[index] - startingBytecodeIndex) * 2;
                    unmatchedJumps.push({ label: jumplabel, bytecodeIndex: jumpOffset + bytecodeIndex, debug });
                }
            }
        }
        return {
            bytecode: acc.bytecode + formattedBytecode,
            sourcemap: [...acc.sourcemap, ...sourcemap],
            jumpindices: { ...jumpindicesInitial, ...jumpindices },
        };
    }, {
        bytecode: '',
        sourcemap: [],
    });

    return {
        data,
        unmatchedJumps,
        jumpindices,
        tableInstances,
    };
};

parser.parseJumpTable = (body, compressed = false) => {
    const jumps = body.match(grammar.jumpTable.JUMPS).map(j => regex.removeSpacesAndLines(j));
    let size;
    if (compressed) {
        size = jumps.length * 0x02;
    } else {
        size = jumps.length * 0x20;
    }
    return {
        jumps,
        size,
        compressed,
    };
};

parser.parseCodeTable = (body) => {
    let index = 0;
    let table = '';
    let whitespace = true;
    let decLiteral = true;
    let hexLiteral = true;
    while (whitespace || decLiteral || hexLiteral) {
        whitespace = body.slice(index).match(grammar.topLevel.WHITESPACE);
        decLiteral = body.slice(index).match(grammar.macro.LITERAL_DECIMAL);
        hexLiteral = body.slice(index).match(grammar.macro.LITERAL_HEX);
        if (whitespace) {
            index += whitespace[0].length;
        } else if (decLiteral) {
            table += new BN(decLiteral[1], 10).toString(16);
            index += decLiteral[0].length;
        } else if (hexLiteral) {
            table += hexLiteral[1];
            index += hexLiteral[0].length;
        } else if (!regex.endOfData(body.slice(index))) {
            const tokenThatFailed = body.slice(index).match('.+?\\b');
            // eslint-disable-next-line no-throw-literal
            throw { index, tokenThatFailed };
        }
    }
    // const table = body.match(grammar.jumpTable.JUMPS).map(j => regex.removeSpacesAndLines(j)).join('');
    const size = table.length / 2;
    return {
        jumps: null,
        table,
        size,
    };
};


// TODO: redo errors in this so inputMap doesn't have to be passed
// TODO: are countEmptyChars needed now whitespace is parsed seperately?
/**
 * Parse an individual macro
 * @param body
 * @param macros
 * @param jumptables
 * @param startingIndex
 * @param inputMap
 * @returns {Array}
 */
parser.parseMacro = (body, macros, jumptables, startingIndex = 0, inputMap = {}) => {
    let input = body;
    let index = 0;
    const ops = [];
    const jumpdests = {};
    while (!regex.endOfData(input)) {
        if (input.match(grammar.macro.MACRO_CALL)) {
            const token = input.match(grammar.macro.MACRO_CALL);
            const macroName = token[1];
            const templateArgs = token[2] ? [token[2]] : [];
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            check(macros[macroName], `expected ${macroName} to be a macro. ` + debugLocationString(debug));
            ops.push({
                type: TYPES.MACRO,
                value: macroName,
                args: templateArgs,
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.TEMPLATE)) {
            const token = input.match(grammar.macro.TEMPLATE);
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            ops.push({
                type: TYPES.TEMPLATE,
                value: token[1],
                args: [],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.CODE_SIZE)) {
            const token = input.match(grammar.macro.CODE_SIZE);
            const templateParams = token[2] ? [token[2]] : [];
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            ops.push({
                type: TYPES.CODESIZE,
                value: token[1],
                args: templateParams,
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.TABLE_SIZE)) {
            const token = input.match(grammar.macro.TABLE_SIZE);
            const table = token[1];
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            if (!jumptables[table]) {
                throw new Error(`could not find jumptable/table ${table} in ${jumptables}. ` + debugLocationString(debug));
            }
            const hex = formatEvenBytes(toHex(jumptables[table].table.size));
            ops.push({
                type: TYPES.PUSH,
                value: toHex(95 + (hex.length / 2)),
                args: [hex],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.TABLE_START)) {
            const token = input.match(grammar.macro.TABLE_START);
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            ops.push({
                type: TYPES.TABLE_START_POSITION,
                value: token[1],
                args: [],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.JUMP_LABEL)) {
            const token = input.match(grammar.macro.JUMP_LABEL);
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            check(!jumpdests[token[1]], `jump label ${token[1]} has already been defined. ` + debugLocationString(debug));
            ops.push({
                type: TYPES.JUMPDEST,
                value: token[1],
                args: [],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,

            });
            jumpdests[token[1]] = true;
            index += token[0].length;
        } else if (input.match(grammar.macro.LITERAL_DECIMAL)) {
            const token = input.match(grammar.macro.LITERAL_DECIMAL);
            const hex = formatEvenBytes(toHex(token[1]));
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            ops.push({
                type: TYPES.PUSH,
                value: toHex(95 + (hex.length / 2)),
                args: [hex],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.LITERAL_HEX)) {
            const token = input.match(grammar.macro.LITERAL_HEX);
            const hex = formatEvenBytes(token[1]);
            const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
            ops.push({
                type: TYPES.PUSH,
                value: toHex(95 + (hex.length / 2)),
                args: [hex],
                index: startingIndex + index + regex.countEmptyChars(token[0]),
                debug,
            });
            index += token[0].length;
        } else if (input.match(grammar.macro.WHITESPACE)) {
            const token = input.match(grammar.macro.WHITESPACE);
            index += token[0].length;
        } else if (input.match(grammar.macro.TOKEN)) {
            const token = input.match(grammar.macro.TOKEN);
            if (opcodes[token[1]]) {
                const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
                ops.push({
                    type: TYPES.OPCODE,
                    value: opcodes[token[1]],
                    args: [],
                    index: startingIndex + index + regex.countEmptyChars(token[0]),
                    debug,

                });
            } else {
                const debug = inputMaps.getFileLine(startingIndex + index + regex.countEmptyChars(token[0]), inputMap);
                ops.push({
                    type: TYPES.PUSH_JUMP_LABEL,
                    value: token[1],
                    args: [],
                    index: startingIndex + index + regex.countEmptyChars(token[0]),
                    debug,
                });
            }
            index += token[0].length;
        } else {
            const debug = inputMaps.getFileLine(startingIndex + index, inputMap);
            throw new Error(`cannot parse ${input}! ` + debugLocationString(debug));
        }
        input = body.slice(index);
    }
    return ops;
};

/**
 * Parse the whole file
 * @param raw
 * @param startingIndex
 * @param inputMap
 * @returns {{macros, jumptables}}
 */
parser.parseTopLevel = (raw, startingIndex, inputMap) => {
    let input = raw.slice(startingIndex);
    let currentContext = CONTEXT.NONE;

    let macros = {};
    let jumptables = {};
    let currentExpression = { templateParams: [] };
    let index = startingIndex;
    while (!regex.endOfData(input)) {
        // if a template declaration is matched
        if (input.match(grammar.topLevel.WHITESPACE)) {
            const whitespace = input.match(grammar.topLevel.WHITESPACE);
            index += whitespace[0].length;
        } else if ((currentContext === CONTEXT.NONE) && input.match(grammar.topLevel.TEMPLATE)) {
            const template = input.match(grammar.topLevel.TEMPLATE);
            const templateParams = regex.sliceCommas(template[1]);
            index += template[0].length;
            currentExpression = {
                ...currentExpression,
                templateParams,
            };
            currentContext = CONTEXT.MACRO;
            // if a macro declaration is matched
        } else if ((currentContext === CONTEXT.MACRO | currentContext === CONTEXT.NONE) && grammar.topLevel.MACRO.test(input)) {
            const macro = input.match(grammar.topLevel.MACRO);
            const type = macro[2];
            const macroName = macro[3];
            // TODO: is countEmptyChars required now I've fixed whitespace?
            const debug = inputMaps.getFileLine(index + regex.countEmptyChars(macro[0]), inputMap);
            check(regex.conformsToNameRules(macro[3]), `macro '${macroName}' does not conform to naming rules. `
                + 'Macro names must contain at least one alphabetical character (A to Z, either case) and must not start'
                + ' with \'0x\'. ' + debugLocationString(debug));
            check(type === 'macro', `expected '${macro[3]}' to define a macro ` + debugLocationString(debug));
            const body = macro[6];
            macros = {
                ...macros,
                [macro[3]]: {
                    ...currentExpression,
                    name: macro[3],
                    takes: macro[4],
                    ops: parser.parseMacro(body, macros, jumptables, index + macro[1].length, inputMap),
                    body: macro[6],
                },
            };
            index += macro[0].length;
            currentContext = CONTEXT.NONE;
            currentExpression = { templateParams: [] };
            // if a code table is matched
        } else if ((currentContext === CONTEXT.NONE) && grammar.topLevel.CODE_TABLE.test(input)) {
            const table = input.match(grammar.topLevel.CODE_TABLE);
            const type = table[2];
            const codeTableName = table[3];
            // TODO: is countEmptyChars required now I've fixed whitespace?
            const debug = inputMaps.getFileLine(index + regex.countEmptyChars(table[0]), inputMap);
            check(regex.conformsToNameRules(codeTableName), `bytecode table '${codeTableName}' does not `
                + 'conform to naming rules. Macro names must contain at least one alphabetical character '
                + '(A to Z, either case) and must not start with \'0x\'. '
                + debugLocationString(debug));
            check(type === 'table', `expected ${codeTableName} to define a packed jump table `
                + debugLocationString(debug));
            const body = table[4];
            let finalTable;
            try {
                finalTable = parser.parseCodeTable(body);
            } catch ({ bodyIndex, tokenThatFailed }) {
                const tableDebug = inputMaps.getFileLine(index + table[1].length + bodyIndex, inputMap);
                if (tokenThatFailed) {
                    throw new Error(`unexpected token '${tokenThatFailed[0]}' in bytecode table '${codeTableName}'. `
                        + 'All tokens in bytecode tables must be decimal and/or hexadecimal literals. '
                        + debugLocationString(debug));
                } else {
                    throw new Error('unexpected error around \''
                        + table[0].slice(bodyIndex, table[0].slice(bodyIndex).indexOf('\n'))
                        + `' in bytecode table '${codeTableName}'. ` + debugLocationString(tableDebug));
                }
            }
            jumptables = {
                ...jumptables,
                [table[3]]: {
                    name: table[3],
                    table: finalTable,
                },
            };
            index += table[0].length;
            // if a packed jumptable is matched
        } else if ((currentContext === CONTEXT.NONE) && grammar.topLevel.JUMP_TABLE_PACKED.test(input)) {
            const jumptable = input.match(grammar.topLevel.JUMP_TABLE_PACKED);
            const type = jumptable[1];
            const packedJumptableName = jumptable[2];
            // TODO: is countEmptyChars required now I've fixed whitespace?
            const debug = inputMaps.getFileLine(index + regex.countEmptyChars(jumptable[0]), inputMap);
            check(regex.conformsToNameRules(packedJumptableName), `packed jumptable '${packedJumptableName}' `
                + 'does not conform to naming rules. Macro names must contain at least one alphabetical character '
                + '(A to Z, either case) and must not start with \'0x\'. ' + debugLocationString(debug));
            check(type === 'jumptable__packed', `expected '${packedJumptableName}' to define a packed jump table `
                + debugLocationString(debug));
            const body = jumptable[3];
            jumptables = {
                ...jumptables,
                [jumptable[2]]: {
                    name: jumptable[2],
                    table: parser.parseJumpTable(body, true),
                },
            };
            index += jumptable[0].length;
            // if a jumptable is matched
        } else if ((currentContext === CONTEXT.NONE) && grammar.topLevel.JUMP_TABLE.test(input)) {
            const jumptable = input.match(grammar.topLevel.JUMP_TABLE);
            const type = jumptable[1];
            const jumptableName = jumptable[2];
            // TODO: is countEmptyChars required now I've fixed whitespace?
            const debug = inputMaps.getFileLine(index + regex.countEmptyChars(jumptable[0]), inputMap);
            check(regex.conformsToNameRules(jumptableName),
                `jumptable '${jumptableName}' does not conform to naming rules. Macro names must contain at `
                + 'least one alphabetical character (A to Z, either case) and must not start with \'0x\'. '
                + debugLocationString(debug));
            check(type === 'jumptable', `expected ${jumptable} to define a jump table. `
                + debugLocationString(debug));
            const body = jumptable[3];
            jumptables = {
                ...jumptables,
                [jumptable[2]]: {
                    name: jumptable[2],
                    table: parser.parseJumpTable(body, false),
                },
            };
            index += jumptable[0].length;
        } else if (input.match(grammar.topLevel.IMPORT)) {
            const token = input.match(grammar.topLevel.IMPORT);
            // TODO: is countEmptyChars required now I've fixed whitespace?
            const debug = inputMaps.getFileLine(index + regex.countEmptyChars(token[0]), inputMap);
            throw new Error('#include statements must come before any other declarations or operations in the file. '
                + debugLocationString(debug));
        } else {
            const { filename, lineNumber, line } = inputMaps.getFileLine(index, inputMap);
            throw new Error(`could not process line ${lineNumber} in ${filename}: ${line}`);
        }
        input = raw.slice(index);
    }
    return { macros, jumptables };
};

/**
 * Strip comments from a string, replacing with equivalent whitespace (maintains line structure)
 * @param string
 * @returns {*}
 */
parser.removeComments = (string) => {
    let data = string;
    const commentRegex = /\/\*(.|\n)*?\*\/|\/\/.*/;
    let match = data.match(commentRegex);
    while (match) {
        data = data.replace(commentRegex, data.match(commentRegex)[0].replace(/./g, ' '));
        match = data.match(commentRegex);
    }
    return data;
};

/**
 * Process contents of file (including dealing with comments and includes) and return processed file contents and a
 * list of other files to include
 * @param originalFilename Also works if you input raw huff code
 * @param partialPath
 * @returns {{filedata: *[], raw: *}}
 */
parser.getFileContents = (originalFilename, partialPath) => {
    const included = [];

    /**
     * Get either the contents of the file parameter, or use the parameter directly if it's Huff code and not a filename
     * @param filename
     * @returns {string}
     */
    const huffCodeFileContents = (filename) => {
        let fileString;
        if (filename.includes('#')) {
            fileString = filename; // hacky workaround for direct strings. TODO: find something more elegant
        } else {
            const filepath = path.posix.resolve(partialPath, filename);
            fileString = fs.readFileSync(filepath, 'utf8');
        }
        return fileString;
    };

    /**
     * Process a file, recursively processing any files which are included
     * @param filename
     * @returns {*[]}
     */
    const processFile = (filename) => {
        included.push(filename);
        const fileString = huffCodeFileContents(filename);
        const fileStringWithoutComments = parser.removeComments(fileString);
        // eslint-disable-next-line no-use-before-define
        const { imported, formatted } = processIncludes(fileStringWithoutComments, filename);
        const result = [...imported, {
            filename,
            data: formatted,
        }];
        return result;
    };

    /**
     * Take comment-free input huff code, and process any include statements recursively, returning a list of the
     * necessary files, and the original huff code with the include statements removed
     * @param formatted
     * @param filename
     * @returns {{formatted: *, imported: Array}}
     */
    const processIncludes = (formatted, filename) => {
        let huffToProcess = formatted;
        let imported = [];
        let index = 0;
        let whitespace = true;
        let importStatement = true;
        while (whitespace || importStatement) {
            whitespace = huffToProcess.slice(index).match(grammar.topLevel.WHITESPACE);
            importStatement = huffToProcess.slice(index).match(grammar.topLevel.IMPORT);
            if (whitespace) {
                index += whitespace[0].length;
            } else if (importStatement) {
                huffToProcess = huffToProcess.replace(importStatement[0], importStatement[0].replace(/./g, ' '));
                index += importStatement[0].length;
                if (!included.includes(importStatement[2])) {
                    imported = [...imported, ...processFile(importStatement[2])];
                } else {
                    const upToNow = huffToProcess.slice(0, index).split('\n').length;
                    console.warn(`Note: file "${importStatement[2]}" is called/imported multiple times, `
                        + `the further import in ${filename} on line ${upToNow} was not carried out.`);
                }
            }
        }
        return { imported, formatted: huffToProcess };
    };

    const filedata = processFile(originalFilename);
    const raw = filedata.reduce((acc, { data }) => {
        return acc + data;
    }, '');
    return { filedata, raw };
};

parser.parseFile = (filename, partialPath) => {
    const { filedata, raw } = parser.getFileContents(filename, partialPath);
    const map = inputMaps.createInputMap(filedata);
    const { macros, jumptables } = parser.parseTopLevel(raw, 0, map);
    return { inputMap: map, macros, jumptables };
};

parser.compileMacro = (macroName, filename, partialPath) => {
    const { filedata, raw } = parser.getFileContents(filename, partialPath);
    const map = inputMaps.createInputMap(filedata);
    const { macros, jumptables } = parser.parseTopLevel(raw, 0, map);
    const { data: { bytecode, sourcemap } } = parser.processMacro(macroName, 0, [], macros, map, jumptables);

    return { bytecode, sourcemap };
};

module.exports = parser;
