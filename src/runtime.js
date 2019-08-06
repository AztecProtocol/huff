/* eslint-disable no-restricted-syntax */
const BN = require('bn.js');
const VM = require('ethereumjs-vm');

const newParser = require('./parser');
const utils = require('./utils');
const { opcodes } = require('./opcodes/opcodes');

// eslint-disable-next-line no-unused-vars
function toBytes32(input, padding = 'left') { // assumes hex format
    let s = input;
    if (s.length > 64) {
        throw new Error(`string ${input} is more than 32 bytes long!`);
    }
    while (s.length < 64) {
        if (padding === 'left') { // left pad to hash a number. Right pad to hash a string
            s = `0${s}`;
        } else {
            s = `${s}0`;
        }
    }
    return s;
}

function getPushOp(hex) {
    const data = utils.formatEvenBytes(hex);
    const opcode = utils.toHex(95 + (data.length / 2));
    return `${opcode}${data}`;
}

function encodeMemory(memory) {
    return memory.reduce((bytecode, { index, value }) => {
        const word = getPushOp(value.toString(16));
        const memIndex = getPushOp(Number(index).toString(16));
        return bytecode + `${word}${memIndex}${opcodes.mstore}`;
    }, '');
}

function encodeStack(stack) {
    return stack.reduce((bytecode, word) => {
        const value = getPushOp(word.toString(16));
        return bytecode + `${value}`;
    }, '');
}

function runCode(vm, bytecode, calldata = null, sourcemapOffset = 0, sourcemap = [], callvalue = 0, debug = false) {
    return new Promise((resolve, reject) => {
        vm.runCode({
            code: Buffer.from(bytecode, 'hex'),
            gasLimit: Buffer.from('ffffffff', 'hex'),
            data: calldata, //  ? processMemory(calldata) : null,
            value: new BN(callvalue),
        }, (err, results) => {
            if (err) {
                if (debug) {
                    console.log(results.runState.programCounter);
                    console.log(sourcemap[results.runState.programCounter - sourcemapOffset]);
                }
                return reject(err);
            }
            return resolve(results);
        });
    });
}

function Runtime(filename, path, debug = false) {
    const { inputMap, macros, jumptables } = newParser.parseFile(filename, path);
    return async function runMacro(macroName, stack = [], memory = [], calldata = null, callvalue = 0) {
        const memoryCode = encodeMemory(memory);
        const stackCode = encodeStack(stack);
        const initCode = `${memoryCode}${stackCode}`;
        const initGasEstimate = (memory.length * 9) + (stack.length * 3);
        const offset = initCode.length / 2;
        const {
            data: { bytecode: macroCode, sourcemap },
        } = newParser.processMacro(macroName, offset, [], macros, inputMap, jumptables);
        const bytecode = `${initCode}${macroCode}`;
        const vm = new VM({ hardfork: 'constantinople' });
        const results = await runCode(vm, bytecode, calldata, offset, sourcemap, callvalue, debug);
        const gasSpent = results.runState.gasLimit.sub(results.runState.gasLeft).sub(new BN(initGasEstimate)).toString(10);
        if (debug) {
            console.log('code size = ', macroCode.length / 2);
            console.log('gas consumed = ', gasSpent);
        }
        return {
            gas: gasSpent,
            stack: results.runState.stack,
            memory: results.runState.memory,
            returnValue: results.runState.returnValue,
            bytecode: macroCode,
        };
    };
}

module.exports = Runtime;
