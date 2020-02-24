const chai = require('chai');

const regex = require('./regex');

const { expect } = chai;

describe('regex tests', () => {
    it('sliceCommas returns comma-delineated array', () => {
        const source = ' a,ba, c ,d';
        const result = regex.sliceCommas(source);
        expect(result).to.deep.equal(['a', 'ba', 'c', 'd']);
    });
    it('sliceCommas will correctly return string if no commas', () => {
        expect(regex.sliceCommas('foo')).to.deep.equal(['foo']);
        expect(regex.sliceCommas('')).to.deep.equal([]);
    });
    it('endOfData will return true if file has no data', () => {
        const source = `
        
            
          
             
        `;
        const result = regex.endOfData(source);
        expect(result).to.equal(true);
    });
    it('endOfData will return false if file has data', () => {
        const source = `
        
            
          a
             
        `;
        const result = regex.endOfData(source);
        expect(result).to.equal(false);
    });

    it('countEmptyChars will get number of spaces', () => {
        const source = ` 
         dup4 
        dup5`;
        const result = regex.countEmptyChars(source);
        expect(result).to.equal(11);
        expect(regex.countEmptyChars('    a b c')).to.equal(4);
        expect(regex.countEmptyChars('a b c')).to.equal(0);
    });

    it('isolateTemplate will identify template name', () => {
        let result = regex.isolateTemplate('foo<bar, baz, bip<ab<cd<e>>>>');
        expect(result).to.deep.equal(['foo', ['bar, baz, bip', ['ab', ['cd', ['e']]]]]);
        result = regex.isolateTemplate('foo<bar>');
        expect(result).to.deep.equal(['foo', ['bar']]);
        result = regex.isolateTemplate('foo');
        expect(result).to.deep.equal(['foo']);
    });

    it('containsOperatorsAndIsNotStackOp will correctly test if operators exist', () => {
        expect(regex.containsOperatorsAndIsNotStackOp('abc + def')).to.equal(true);
        expect(regex.containsOperatorsAndIsNotStackOp('abc - def')).to.equal(true);
        expect(regex.containsOperatorsAndIsNotStackOp('abc * def')).to.equal(true);
        expect(regex.containsOperatorsAndIsNotStackOp('abc , def')).to.equal(false);
    });

    it('isLiteral will correctly test if string is a literal', () => {
        expect(regex.isLiteral('A+B')).to.equal(true);
        expect(regex.isLiteral('A + 0x10')).to.equal(true);
        expect(regex.isLiteral('0x12345')).to.equal(true);
        expect(regex.isLiteral('12345678912432342')).to.equal(true);
        expect(regex.isLiteral('dup4 mulmod')).to.equal(false);
    });
});
