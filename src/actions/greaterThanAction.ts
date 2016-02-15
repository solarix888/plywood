module Plywood {
  export class GreaterThanAction extends Action {
    static fromJS(parameters: ActionJS): GreaterThanAction {
      return new GreaterThanAction(Action.jsToValue(parameters));
    }

    constructor(parameters: ActionValue) {
      super(parameters, dummyObject);
      this._ensureAction("greaterThan");
      this._checkExpressionTypes('NUMBER', 'TIME');
    }

    public getOutputType(inputType: string): string {
      this._checkInputTypes(inputType, this.expression.type);
      return 'BOOLEAN';
    }

    protected _getFnHelper(inputFn: ComputeFn, expressionFn: ComputeFn): ComputeFn {
      return (d: Datum, c: Datum) => {
        return inputFn(d, c) > expressionFn(d, c);
      }
    }

    protected _getJSHelper(inputJS: string, expressionJS: string): string {
      return `(${inputJS}>${expressionJS})`;
    }

    protected _getSQLHelper(dialect: SQLDialect, inputSQL: string, expressionSQL: string): string {
      return `(${inputSQL}>${expressionSQL})`;
    }

    protected _specialSimplify(simpleExpression: Expression): Action {
      var expression = this.expression;
      if (expression instanceof LiteralExpression) { // x > 5
        return new InAction({
          expression: new LiteralExpression({
            value: Range.fromJS({ start: expression.value, end: null, bounds: '()' })
          })
        });
      }
      return null;
    }

    protected _performOnLiteral(literalExpression: LiteralExpression): Expression {
      // 5 > x
      return (new InAction({
        expression: new LiteralExpression({
          value: Range.fromJS({ start: null, end: literalExpression.value, bounds: '()' })
        })
      })).performOnSimple(this.expression);
    }
  }

  Action.register(GreaterThanAction);
}
