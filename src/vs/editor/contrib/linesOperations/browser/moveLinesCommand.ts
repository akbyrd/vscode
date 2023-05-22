/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as strings from 'vs/base/common/strings';
import { ShiftCommand } from 'vs/editor/common/commands/shiftCommand';
import { EditorAutoIndentStrategy } from 'vs/editor/common/config/editorOptions';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { ICommand, ICursorStateComputerData, IEditOperationBuilder } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { CompleteEnterAction, IndentAction } from 'vs/editor/common/languages/languageConfiguration';
import { ILanguageConfigurationService } from 'vs/editor/common/languages/languageConfigurationRegistry';
import { IndentConsts } from 'vs/editor/common/languages/supports/indentRules';
import * as indentUtils from 'vs/editor/contrib/indentation/browser/indentUtils';
import { getGoodIndentForLine, getIndentMetadata, IIndentConverter, IVirtualModel } from 'vs/editor/common/languages/autoIndent';
import { getEnterAction } from 'vs/editor/common/languages/enterAction';
import { LineRange } from 'vs/editor/common/core/lineRange';

export class MoveLinesCommand implements ICommand {

	private readonly _selection: Selection;
	private readonly _isMovingDown: boolean;
	private readonly _autoIndent: EditorAutoIndentStrategy;
	private readonly _batch: LineRange;
	private readonly _isFirstInBatch: boolean;

	private _selectionId: string | null;
	private _moveEndLineSelectionShrink: boolean;

	constructor(
		selections: Selection[],
		isMovingDown: boolean,
		autoIndent: EditorAutoIndentStrategy,
		@ILanguageConfigurationService private readonly _languageConfigurationService: ILanguageConfigurationService,
		batch: LineRange,
		isFirstInBatch: boolean
	) {
		this._selection = selections[0];
		this._isMovingDown = isMovingDown;
		this._autoIndent = autoIndent;
		this._selectionId = null;
		this._moveEndLineSelectionShrink = false;
		this._batch = batch;
		this._isFirstInBatch = isFirstInBatch;
	}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {

		const modelLineCount = model.getLineCount();

		// Moving down but selection is at the end of the document, nothing to do
		if (this._isMovingDown && this._batch.endLineNumberExclusive - 1 === modelLineCount) {
			this._selectionId = builder.trackSelection(this._selection);
			return;
		}

		// Moving up but selection is at the beginning of the document, nothing to do
		if (!this._isMovingDown && this._batch.startLineNumber === 1) {
			this._selectionId = builder.trackSelection(this._selection);
			return;
		}

		const s = this._selection;
		builder.trackSelection(s);

		const { tabSize, indentSize, insertSpaces } = model.getOptions();
		const indentConverter = this.buildIndentConverter(tabSize, indentSize, insertSpaces);
		const virtualModel: IVirtualModel = {
			tokenization: {
				getLineTokens: (lineNumber: number) => {
					return model.tokenization.getLineTokens(lineNumber);
				},
				getLanguageId: () => {
					return model.getLanguageId();
				},
				getLanguageIdAtPosition: (lineNumber: number, column: number) => {
					return model.getLanguageIdAtPosition(lineNumber, column);
				},
			},
			getLineContent: null as unknown as (lineNumber: number) => string,
		};

		if (this._isFirstInBatch) {
			// Grab the text that needs to be moved
			// (without a leading or trailing newline)
			const srcStartLine = this._batch.startLineNumber;
			const srcEndLine = this._batch.endLineNumberExclusive - 1;
			const srcEndLineLen = model.getLineMaxColumn(srcEndLine);
			const textRange = new Range(srcStartLine, 1, srcEndLine, srcEndLineLen);
			const text = model.getValueInRange(textRange);

			// TODO: It's probably equivalent to special case first and last line as opposed to up vs down. Does that make
			// it simpler to grab the text?
			const prevLine = this._batch.startLineNumber - 1;
			const nextLine = this._batch.endLineNumberExclusive;

			// Remove it
			if (this._isMovingDown) {
				// (along with the proceeding newline, so we don't need a special case for moving from the first line)
				const removeRange = new Range(srcStartLine, 1, nextLine, 1);
				builder.addEditOperation(removeRange, null);
			} else {
				// (along with the preceding newline, so we don't need a special case for moving from the last line)
				const prevLineLen = model.getLineMaxColumn(prevLine);
				const removeRange = new Range(prevLine, prevLineLen, srcEndLine, srcEndLineLen);
				builder.addEditOperation(removeRange, null);
			}

			// Re-insert it
			// (using a trailing newline so we don't need a special case for moving to the first line)
			if (this._isMovingDown) {
				const dstLine = this._batch.startLineNumber - 1;
				const insertRange = new Range(dstLine, 1, dstLine, 1);
				builder.addEditOperation(insertRange, '\n' + text);
			} else {
				const dstLine = this._batch.endLineNumberExclusive;
				const insertRange = new Range(dstLine, 1, dstLine, 1);
				builder.addEditOperation(insertRange, text + '\n');
			}

			// TODO: Handle moving past a line that is actually multiple lines folded into one

			// Re-indent the moved lines and the line they moved past
			if (this.shouldAutoIndent(model, s)) {
				let matchedOnEnterRule = false;

				// Attempt to indent based on onEnter rules
				if (this._isMovingDown) {
					const ret = this.matchEnterRuleMovingDown(model, indentConverter, tabSize, srcStartLine, nextLine, text);
					if (ret !== null) {
						matchedOnEnterRule = true;
						if (ret !== 0) {
							this.getIndentEditsOfMovingBlock(model, builder, s, tabSize, insertSpaces, ret);
						}
					}
				} else {
					const ret = this.matchEnterRuleMoveingUp(model, indentConverter, tabSize, srcStartLine, prevLine, text);
					if (ret !== null) {
						matchedOnEnterRule = true;
						if (ret !== 0) {
							this.getIndentEditsOfMovingBlock(model, builder, s, tabSize, insertSpaces, ret);
						}
					}
				}

				// If no onEnter rule matched we'll check indentation rules
				if (!matchedOnEnterRule) {

					// NOTE: Given a line number from before the change return the line content after the change
					virtualModel.getLineContent = (lineNumber: number) => {
						if (this._isMovingDown) {
							if (lineNumber === srcStartLine) {
								return model.getLineContent(nextLine);
							} else if (lineNumber <= nextLine) {
								return model.getLineContent(lineNumber + 1);
							} else {
								return model.getLineContent(lineNumber);
							}
						} else {
							if (lineNumber === srcEndLine) {
								return model.getLineContent(prevLine);
							} else if (lineNumber >= prevLine) {
								return model.getLineContent(lineNumber - 1);
							} else {
								return model.getLineContent(lineNumber);
							}
						}
					};

					// 'affected' denotes all modified lines - the moved lines plus the line they are being moved past
					// 'adjacent' denoates the line that isn't being moved, but is being moved past
					const affectedStartLine = this._isMovingDown ? srcStartLine : prevLine;
					const affectedEndLine = this._isMovingDown ? nextLine : srcEndLine;
					//const adjacentLine = this._isMovingDown ? nextLine : prevLine;

					for (let i = affectedStartLine; i <= affectedEndLine; i++) {
						const lineIndent = getGoodIndentForLine(
							this._autoIndent,
							virtualModel,
							model.getLanguageIdAtPosition(i, 1),
							i,
							indentConverter,
							this._languageConfigurationService
						);
						if (lineIndent !== null) {
							// adjust the indentation of the moving block
							const oldIndent = strings.getLeadingWhitespace(virtualModel.getLineContent(i));
							const newSpaceCnt = indentUtils.getSpaceCnt(lineIndent, tabSize);
							const oldSpaceCnt = indentUtils.getSpaceCnt(oldIndent, tabSize);
							if (newSpaceCnt !== oldSpaceCnt) {
								const spaceCntOffset = newSpaceCnt - oldSpaceCnt;
								this.getIndentEditsOfMovingBlock(model, builder, s, tabSize, insertSpaces, spaceCntOffset);
							}
						}
					}
				}
			}
		} else {
			// TODO: Ensure this can't get filtered
			// No-op so we still get a chance to update our cursor position
			builder.addEditOperation(new Range(1, 1, 1, 1), null);
		}
	}

	private buildIndentConverter(tabSize: number, indentSize: number, insertSpaces: boolean): IIndentConverter {
		return {
			shiftIndent: (indentation) => {
				return ShiftCommand.shiftIndent(indentation, indentation.length + 1, tabSize, indentSize, insertSpaces);
			},
			unshiftIndent: (indentation) => {
				return ShiftCommand.unshiftIndent(indentation, indentation.length + 1, tabSize, indentSize, insertSpaces);
			}
		};
	}

	private parseEnterResult(model: ITextModel, indentConverter: IIndentConverter, tabSize: number, line: number, enter: CompleteEnterAction | null) {
		if (enter) {
			let enterPrefix = enter.indentation;

			if (enter.indentAction === IndentAction.None) {
				enterPrefix = enter.indentation + enter.appendText;
			} else if (enter.indentAction === IndentAction.Indent) {
				enterPrefix = enter.indentation + enter.appendText;
			} else if (enter.indentAction === IndentAction.IndentOutdent) {
				enterPrefix = enter.indentation;
			} else if (enter.indentAction === IndentAction.Outdent) {
				enterPrefix = indentConverter.unshiftIndent(enter.indentation) + enter.appendText;
			}
			const movingLineText = model.getLineContent(line);
			if (this.trimLeft(movingLineText).indexOf(this.trimLeft(enterPrefix)) >= 0) {
				const oldIndentation = strings.getLeadingWhitespace(model.getLineContent(line));
				let newIndentation = strings.getLeadingWhitespace(enterPrefix);
				const indentMetadataOfMovelingLine = getIndentMetadata(model, line, this._languageConfigurationService);
				if (indentMetadataOfMovelingLine !== null && indentMetadataOfMovelingLine & IndentConsts.DECREASE_MASK) {
					newIndentation = indentConverter.unshiftIndent(newIndentation);
				}
				const newSpaceCnt = indentUtils.getSpaceCnt(newIndentation, tabSize);
				const oldSpaceCnt = indentUtils.getSpaceCnt(oldIndentation, tabSize);
				return newSpaceCnt - oldSpaceCnt;
			}
		}

		return null;
	}

	private matchEnterRuleMovingDown(model: ITextModel, indentConverter: IIndentConverter, tabSize: number, line: number, nextLine: number, nextLineText: string) {
		if (strings.lastNonWhitespaceIndex(nextLineText) >= 0) {
			const maxColumn = model.getLineMaxColumn(nextLine);
			const enter = getEnterAction(this._autoIndent, model, new Range(nextLine, maxColumn, nextLine, maxColumn), this._languageConfigurationService);
			return this.parseEnterResult(model, indentConverter, tabSize, line, enter);
		} else {
			// go upwards, starting from `line - 1`
			let validPrecedingLine = line - 1;
			while (validPrecedingLine >= 1) {
				const lineContent = model.getLineContent(validPrecedingLine);
				const nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineContent);

				if (nonWhitespaceIdx >= 0) {
					break;
				}

				validPrecedingLine--;
			}

			if (validPrecedingLine < 1 || line > model.getLineCount()) {
				return null;
			}

			const maxColumn = model.getLineMaxColumn(validPrecedingLine);
			const enter = getEnterAction(this._autoIndent, model, new Range(validPrecedingLine, maxColumn, validPrecedingLine, maxColumn), this._languageConfigurationService);
			return this.parseEnterResult(model, indentConverter, tabSize, line, enter);
		}
	}

	private matchEnterRuleMoveingUp(model: ITextModel, indentConverter: IIndentConverter, tabSize: number, line: number, prevLine: number, prevLineText: string) {
		let validPrecedingLine = prevLine;
		while (validPrecedingLine >= 1) {
			// skip empty lines as empty lines just inherit indentation
			let lineContent;
			if (validPrecedingLine === prevLine) {
				lineContent = prevLineText;
			} else {
				lineContent = model.getLineContent(validPrecedingLine);
			}

			// TODO: I bet this gets confused by whitespace only lines with incorrect indentation
			// TODO: I bet this is weird for languages without braces like Python
			const nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineContent);
			if (nonWhitespaceIdx >= 0) {
				break;
			}
			validPrecedingLine--;
		}

		if (validPrecedingLine < 1 || line > model.getLineCount()) {
			return null;
		}

		const maxColumn = model.getLineMaxColumn(validPrecedingLine);
		const enter = getEnterAction(this._autoIndent, model, new Range(validPrecedingLine, maxColumn, validPrecedingLine, maxColumn), this._languageConfigurationService);
		return this.parseEnterResult(model, indentConverter, tabSize, line, enter);
	}

	private trimLeft(str: string) {
		return str.replace(/^\s+/, '');
	}

	private shouldAutoIndent(model: ITextModel, selection: Selection) {
		if (this._autoIndent < EditorAutoIndentStrategy.Full) {
			return false;
		}
		// if it's not easy to tokenize, we stop auto indent.
		if (!model.tokenization.isCheapToTokenize(selection.startLineNumber)) {
			return false;
		}
		const languageAtSelectionStart = model.getLanguageIdAtPosition(selection.startLineNumber, 1);
		const languageAtSelectionEnd = model.getLanguageIdAtPosition(selection.endLineNumber, 1);

		if (languageAtSelectionStart !== languageAtSelectionEnd) {
			return false;
		}

		if (this._languageConfigurationService.getLanguageConfiguration(languageAtSelectionStart).indentRulesSupport === null) {
			return false;
		}

		return true;
	}

	private getIndentEditsOfMovingBlock(model: ITextModel, builder: IEditOperationBuilder, s: Selection, tabSize: number, insertSpaces: boolean, offset: number) {
		for (let i = s.startLineNumber; i <= s.endLineNumber; i++) {
			const lineContent = model.getLineContent(i);
			const originalIndent = strings.getLeadingWhitespace(lineContent);
			const originalSpacesCnt = indentUtils.getSpaceCnt(originalIndent, tabSize);
			const newSpacesCnt = originalSpacesCnt + offset;
			const newIndent = indentUtils.generateIndent(newSpacesCnt, tabSize, insertSpaces);

			if (newIndent !== originalIndent) {
				builder.addEditOperation(new Range(i, 1, i, originalIndent.length + 1), newIndent);

				if (i === s.endLineNumber && s.endColumn <= originalIndent.length + 1 && newIndent === '') {
					// as users select part of the original indent white spaces
					// when we adjust the indentation of endLine, we should adjust the cursor position as well.
					this._moveEndLineSelectionShrink = true;
				}
			}

		}
	}

	public computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		let result = helper.getTrackedSelection(this._selectionId!);

		if (this._moveEndLineSelectionShrink && result.startLineNumber < result.endLineNumber) {
			result = result.setEndPosition(result.endLineNumber, 2);
		}

		const offset = this._isMovingDown ? 1 : -1;
		result = this._selection;
		result = new Selection(result.startLineNumber + offset, result.startColumn, result.endLineNumber + offset, result.endColumn);

		return result;
	}
}
