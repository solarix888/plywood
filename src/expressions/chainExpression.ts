/*
 * Copyright 2015-2016 Imply Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as Q from 'q';
import { immutableArraysEqual } from 'immutable-class';
import {
  r,
  ply,
  Expression,
  ExpressionValue,
  ExpressionJS,
  Alterations,
  Indexer,
  ExpressionMatchFn,
  ExtractAndRest,
  SubstitutionFn,
  BooleanExpressionIterator
} from './baseExpression';
import { PlyType, DatasetFullType, PlyTypeSingleValue, FullType } from '../types';
import { ExternalExpression } from './externalExpression';
import { Action, ApplyAction, FilterAction, LimitAction, SelectAction, SortAction } from '../actions/index';
import { Dataset, Datum, PlywoodValue } from '../datatypes/index';
import { SQLDialect } from '../dialect/baseDialect';
import { hasOwnProperty, repeat, arraysEqual } from '../helper/utils';
import { RefExpression } from './refExpression';
import { ComputeFn } from '../datatypes/dataset';

export class ChainExpression extends Expression {
  static fromJS(parameters: ExpressionJS): ChainExpression {
    var value: ExpressionValue = {
      op: parameters.op
    };
    value.expression = Expression.fromJS(parameters.expression);
    if (hasOwnProperty(parameters, 'action')) {
      value.actions = [Action.fromJS(parameters.action)];
    } else {
      if (!Array.isArray(parameters.actions)) throw new Error('chain `actions` must be an array');
      value.actions = parameters.actions.map(Action.fromJS);
    }

    return new ChainExpression(value);
  }

  public expression: Expression;
  public actions: Action[];

  constructor(parameters: ExpressionValue) {
    super(parameters, dummyObject);
    var expression = parameters.expression;
    var actions = parameters.actions;
    if (!actions.length) throw new Error('can not have empty actions');
    this._ensureOp('chain');

    var type = expression.type;
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      var upgradedAction = action.getUpgradedType(type);
      if (upgradedAction !== action) {
        actions = actions.slice();
        actions[i] = action = upgradedAction;
      }

      try {
        type = action.getOutputType(type);
      } catch (e) {
        var neededType: PlyType = action.getNecessaryInputTypes() as PlyType;
        // todo: neededType could be more than 1 value, just so happens that with current tests cases neededType always returns one value
        if (i === 0) {
            expression = expression.upgradeToType(neededType);
            type = expression.type;
        } else {
            var upgradedChain = new ChainExpression({
              expression,
              actions: actions.slice(0, i)
            }).upgradeToType(neededType);
            expression = (upgradedChain as ChainExpression).expression;
            actions = (upgradedChain as ChainExpression).actions;
            type = upgradedChain.type;
        }

        type = action.getOutputType(type);
      }
    }
    this.expression = expression;
    this.actions = actions;
    this.type = type;
  }

  public upgradeToType(neededType: PlyType): Expression {
    const actions = this.actions;
    var upgradedActions: Action[] = [];
    for (var i = actions.length - 1; i >= 0; i--) {
      var action = actions[i];
      var upgradedAction = action.getUpgradedType(neededType);
      upgradedActions.unshift(upgradedAction);
      neededType = upgradedAction.getNeededType();
    }
    var value = this.valueOf();
    value.actions = upgradedActions;
    value.expression = this.expression.upgradeToType(neededType);
    return new ChainExpression(value);
  }

  public valueOf(): ExpressionValue {
    var value = super.valueOf();
    value.expression = this.expression;
    value.actions = this.actions;
    return value;
  }

  public toJS(): ExpressionJS {
    var js = super.toJS();
    js.expression = this.expression.toJS();

    var { actions } = this;
    if (actions.length === 1) {
      js.action = actions[0].toJS();
    } else {
      js.actions = actions.map(action => action.toJS());
    }
    return js;
  }

  public toString(indent?: int): string {
    var expression = this.expression;
    var actions = this.actions;
    var joinStr = '.';
    var nextIndent: int = null;
    if (indent != null && (actions.length > 1 || expression.type === 'DATASET')) {
      joinStr = '\n' + repeat(' ', indent) + joinStr;
      nextIndent = indent + 2;
    }
    return [expression.toString()]
      .concat(actions.map(action => action.toString(nextIndent)))
      .join(joinStr);
  }

  public equals(other: ChainExpression): boolean {
    return super.equals(other) &&
           this.expression.equals(other.expression) &&
           immutableArraysEqual(this.actions, other.actions);
  }

  public expressionCount(): int {
    var expressionCount = 1 + this.expression.expressionCount();
    var actions = this.actions;
    for (let action of actions) {
      expressionCount += action.expressionCount();
    }
    return expressionCount;
  }

  public getFn(): ComputeFn {
    var { expression, actions} = this;
    var fn = expression.getFn();
    var type = expression.type;
    for (let action of actions) {
      fn = action.getFn(type, fn);
      type = action.getOutputType(type);
    }
    return fn;
  }

  public getJS(datumVar: string): string {
    var { expression, actions} = this;
    var js = expression.getJS(datumVar);
    var type = expression.type;
    for (let action of actions) {
      js = action.getJS(type, js, datumVar);
      type = action.getOutputType(type);
    }
    return js;
  }

  public getSQL(dialect: SQLDialect): string {
    var { expression, actions} = this;
    var sql = expression.getSQL(dialect);
    var type = expression.type;
    for (let action of actions) {
      sql = action.getSQL(type, sql, dialect);
      type = action.getOutputType(type);
    }
    return sql;
  }

  /**
   * Returns the single action of the chain, if there are multiple actions null is returned
   * @param neededAction and optional type can be passed in to return only an action of this type
   * @returns Action
   */
  public getSingleAction(neededAction?: string): Action {
    var actions = this.actions;
    if (actions.length !== 1) return null;
    var singleAction = actions[0];
    if (neededAction && singleAction.action !== neededAction) return null;
    return singleAction;
  }

  public foldIntoExternal(): Expression {
    const { expression, actions } = this;
    var baseExternals = this.getBaseExternals();
    if (baseExternals.length === 0) return this;

    // Looks like: $().blah().blah(ValueExternal()).blah()
    return this.substituteAction(
      (action) => {
        var expression = action.expression;
        return (expression instanceof ExternalExpression) && expression.external.mode === 'value';
      },
      (preEx: Expression, action: Action) => {
        var external = (action.expression as ExternalExpression).external;
        var prePacked = external.prePack(preEx, action);
        if (!prePacked) return null;
        return new ExternalExpression({
          external: prePacked
        });
      },
      {
        onceInChain: true
      }
    ).simplify();
  }

  public simplify(): Expression {
    if (this.simple) return this;
    var simpleExpression = this.expression.simplify();
    var actions = this.actions;

    // In the unlikely event that there is a chain of a chain => merge them
    if (simpleExpression instanceof ChainExpression) {
      return new ChainExpression({
        expression: simpleExpression.expression,
        actions: simpleExpression.actions.concat(actions)
      }).simplify();
    }

    // Let the actions simplify (and re-arrange themselves)
    for (let action of actions) {
      simpleExpression = action.performOnSimple(simpleExpression);
    }

    // Return now if already as simple as can be
    if (!simpleExpression.isOp('chain')) return simpleExpression;

    return (simpleExpression as ChainExpression).foldIntoExternal();
  }

  public _everyHelper(iter: BooleanExpressionIterator, thisArg: any, indexer: Indexer, depth: int, nestDiff: int): boolean {
    var pass = iter.call(thisArg, this, indexer.index, depth, nestDiff);
    if (pass != null) {
      return pass;
    } else {
      indexer.index++;
    }
    depth++;

    var expression = this.expression;
    if (!expression._everyHelper(iter, thisArg, indexer, depth, nestDiff)) return false;

    var actions = this.actions;
    var every = true;
    for (let action of actions) {
      if (every) {
        every = action._everyHelper(iter, thisArg, indexer, depth, nestDiff);
      } else {
        indexer.index += action.expressionCount();
      }
    }
    return every;
  }

  public _substituteHelper(substitutionFn: SubstitutionFn, thisArg: any, indexer: Indexer, depth: int, nestDiff: int): Expression {
    var sub = substitutionFn.call(thisArg, this, indexer.index, depth, nestDiff);
    if (sub) {
      indexer.index += this.expressionCount();
      return sub;
    } else {
      indexer.index++;
    }
    depth++;

    var expression = this.expression;
    var subExpression = expression._substituteHelper(substitutionFn, thisArg, indexer, depth, nestDiff);

    var actions = this.actions;
    var subActions = actions.map(action => action._substituteHelper(substitutionFn, thisArg, indexer, depth, nestDiff));
    if (expression === subExpression && arraysEqual(actions, subActions)) return this;

    var value = this.valueOf();
    value.expression = subExpression;
    value.actions = subActions;
    delete value.simple;
    return new ChainExpression(value);
  }

  public performAction(action: Action, markSimple?: boolean): ChainExpression {
    if (!action) throw new Error('must have action');
    return new ChainExpression({
      expression: this.expression,
      actions: this.actions.concat(action),
      simple: Boolean(markSimple)
    });
  }

  public _fillRefSubstitutions(typeContext: DatasetFullType, indexer: Indexer, alterations: Alterations): FullType {
    indexer.index++;

    // Some explanation of what is going on here is in order as this is the heart of the variable resolution code
    // The _fillRefSubstitutions function is chained across all the expressions.
    // If an expression returns a DATASET type it is treated as the new context otherwise the original context is
    // used for the next expression (currentContext)
    var currentContext: DatasetFullType = typeContext;
    var outputContext = this.expression._fillRefSubstitutions(currentContext, indexer, alterations);
    currentContext = outputContext.type === 'DATASET' ? <DatasetFullType>outputContext : typeContext;

    var actions = this.actions;
    for (let action of actions) {
      outputContext = action._fillRefSubstitutions(currentContext, outputContext, indexer, alterations);
      currentContext = outputContext.type === 'DATASET' ? <DatasetFullType>outputContext : typeContext;
    }

    return outputContext;
  }

  public actionize(containingAction: string): Action[] {
    var actions = this.actions;

    var k = actions.length - 1;
    for (; k >= 0; k--) {
      if (actions[k].action !== containingAction) break;
    }
    k++; // k now represents the number of actions that remain in the chain
    if (k === actions.length) return null; // nothing to do

    var newExpression: Expression;
    if (k === 0) {
      newExpression = this.expression;
    } else {
      var value = this.valueOf();
      value.actions = actions.slice(0, k);
      newExpression = new ChainExpression(value);
    }

    var ActionConstructor = Action.classMap[containingAction] as any;
    return [
      new ActionConstructor({
        expression: newExpression
      })
    ].concat(actions.slice(k));
  }

  public firstAction(): Action {
    return this.actions[0] || null;
  }

  public lastAction(): Action {
    var { actions } = this;
    return actions[actions.length - 1] || null;
  }

  public headActions(n: int): Expression {
    var { actions } = this;
    if (actions.length <= n) return this;
    if (n <= 0) return this.expression;

    var value = this.valueOf();
    value.actions = actions.slice(0, n);
    return new ChainExpression(value);
  }

  public popAction(): Expression {
    var actions = this.actions;
    if (!actions.length) return null;
    actions = actions.slice(0, -1);
    if (!actions.length) return this.expression;
    var value = this.valueOf();
    value.actions = actions;
    return new ChainExpression(value);
  }

  public extractFromAnd(matchFn: ExpressionMatchFn): ExtractAndRest {
    if (!this.simple) return this.simplify().extractFromAnd(matchFn);

    var andExpressions = this.getExpressionPattern('and');
    if (!andExpressions) return super.extractFromAnd(matchFn);

    var includedExpressions: Expression[] = [];
    var excludedExpressions: Expression[] = [];
    for (let ex of andExpressions) {
      if (matchFn(ex)) {
        includedExpressions.push(ex);
      } else {
        excludedExpressions.push(ex);
      }
    }

    return {
      extract: Expression.and(includedExpressions).simplify(),
      rest: Expression.and(excludedExpressions).simplify()
    };
  }

  public maxPossibleSplitValues(): number {
    return this.type === 'BOOLEAN' ? 3 : this.lastAction().maxPossibleSplitValues();
  }
}

Expression.register(ChainExpression);
