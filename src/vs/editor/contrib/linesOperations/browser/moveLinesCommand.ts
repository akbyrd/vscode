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

		// TODO: Remove this
		const s = this._selection;
		//this._selectionId = builder.trackSelection(s);
		const isMovingDown = this._isMovingDown;

		if (!this._isFirstInBatch) {
			// TODO: Ensure this can't get filtered
			// No-op so we still get a chance to update our cursor position
			builder.addEditOperation(new Range(1, 1, 1, 1), null);
			return;
		}

		// Moving down but selection is at the end of the document, nothing to do
		if (isMovingDown && this._batch.endLineNumberExclusive - 1 === model.getLineCount()) {
			return;
		}

		// Moving up but selection is at the beginning of the document, nothing to do
		if (!isMovingDown && this._batch.startLineNumber === 1) {
			return;
		}

		// In order for this command to work properly we need to know about adjacent cursors.
		// * Edit operations are not allowed to overlap and when we have adjacent cursors their edits invariably end up
		//   overlapping. Consider lines 2 and 3 have a cursor and we want to move those lines up up. When line 2 is
		//   processed Line 1 is removed and reinserted below 2. When line 3 is processed we try to remove line 2 and
		//   reinsert it below 3. Since line 2 already has pending edits this is rejected and the second cursor is
		//   removed.
		// * When re-indenting lines after a move we look at the indentation of the previous line. If the previous line
		//   was also moved and got reindented we need to see the new indentation in order to make the right decision
		//   about our own indentation.

		// TODO: Maybe moving only the adjacent line is better?
		// * Can re-indent all other lines in-place
		// * Cursors should be updated automatically

		// TODO: Pick up all affected lines, modify them, put them down
		// * Don't have to handle first and last lines specially
		// * Simplest implementation
		// * A lot more work overall (if we're not re-indenting)
		// * Need shared state to update cursor positions (due to indentation changes)

		// TODO: I'm assuming an ICommand is not the right place to implement this. There must be tools have a broader
		// view of the document

		// TODO: It's probably equivalent to special case first and last line as opposed to up vs down. Does that make
		// it simpler to grab the text?

		const srcStartLine = this._batch.startLineNumber;
		const srcEndLine = this._batch.endLineNumberExclusive - 1;

		const prevLine = srcStartLine - 1;
		const nextLine = srcEndLine + 1;

		const affectedStartLine = isMovingDown ? srcStartLine : prevLine;
		const affectedEndLine = isMovingDown ? nextLine : srcEndLine;
		const affectedEndLineLen = model.getLineMaxColumn(affectedEndLine);
		const replaceRange = new Range(affectedStartLine, 1, affectedEndLine, affectedEndLineLen);

		// TODO: I'm undecided about gathering all lines in an array.
		// On one hand it's wasteful if we're not reindenting
		// On the other we *have* to do it when reindenting because we need to see the re-indented state of previous lines
		const affectedLines = new Array<string>();
		if (isMovingDown) {
			affectedLines.push(model.getLineContent(nextLine));
			for (let i = srcStartLine; i <= srcEndLine; i++) {
				affectedLines.push(model.getLineContent(i));
			}
		} else {
			for (let i = srcStartLine; i <= srcEndLine; i++) {
				affectedLines.push(model.getLineContent(i));
			}
			affectedLines.push(model.getLineContent(prevLine));
		}

		// Re-indent all affected lines
		if (this.shouldAutoIndent(model, s)) {
			const { tabSize, indentSize, insertSpaces } = model.getOptions();
			const indentConverter = this.buildIndentConverter(tabSize, indentSize, insertSpaces);

			// TODO: Move this into virtualModel
			function convertLineNumber(lineNumber: number) {
				if (isMovingDown) {
					if (lineNumber === srcStartLine) {
						return nextLine;
					} else if (lineNumber > srcStartLine && lineNumber <= nextLine) {
						return lineNumber - 1;
					}
				} else {
					if (lineNumber === srcEndLine) {
						return prevLine;
					} else if (lineNumber >= prevLine && lineNumber < srcEndLine) {
						return lineNumber + 1;
					}
				}
				return lineNumber;
			}

			const virtualModel: IVirtualModel = {
				tokenization: {
					// TODO: This will be wrong after re-indenting. Consider tokenizeLineWithEdit
					getLineTokens: (lineNumber: number) => {
						lineNumber = convertLineNumber(lineNumber);
						return model.tokenization.getLineTokens(lineNumber);
					},
					getLanguageId: () => {
						return model.getLanguageId();
					},
					getLanguageIdAtPosition: (lineNumber: number, column: number) => {
						lineNumber = convertLineNumber(lineNumber);
						return model.getLanguageIdAtPosition(lineNumber, column);
					},
				},
				getLineContent: (lineNumber: number) => {
					if (lineNumber >= affectedStartLine && lineNumber <= affectedEndLine) {
						return affectedLines[lineNumber - affectedStartLine];
					} else {
						return model.getLineContent(lineNumber);
					}
				},
			};

			for (let i = affectedStartLine; i <= affectedEndLine; i++) {
				const affectedLineIndex = i - affectedStartLine;
				const oldLineContent = affectedLines[affectedLineIndex];

				let newSpaceCount: number | null;

				// Attempt to indent based on onEnter rules
				if (isMovingDown) {
					newSpaceCount = this.matchEnterRuleMovingDown(virtualModel, indentConverter, tabSize, srcStartLine, nextLine, text);
				} else {
					newSpaceCount = this.matchEnterRuleMoveingUp(virtualModel, indentConverter, tabSize, srcStartLine, prevLine, text);
				}

				// If no onEnter rule matched we'll check indentation rules
				if (newSpaceCount === null) {
					const languageId = virtualModel.tokenization.getLanguageIdAtPosition(i, 1);
					const newIndent = getGoodIndentForLine(this._autoIndent, virtualModel, languageId, i, indentConverter, this._languageConfigurationService);
					if (newIndent !== null) {
						newSpaceCount = indentUtils.getSpaceCnt(newIndent, tabSize);
					}
				}

				if (newSpaceCount !== null) {
					const oldIndent = strings.getLeadingWhitespace(oldLineContent);
					const oldSpaceCount = indentUtils.getSpaceCnt(oldIndent, tabSize);

					if (newSpaceCount !== oldSpaceCount) {
						const newIndent = indentUtils.generateIndent(newSpaceCount, tabSize, insertSpaces);
						const newLineContent = newIndent + oldLineContent.substring(oldIndent.length);
						console.log('indent changed (%i) old: \"%s\"; new: \"%s\"', i, oldLineContent, newLineContent);
						affectedLines[affectedLineIndex] = newLineContent;
					}
				}
			}
		}

		const text = affectedLines.join('\n');
		builder.addEditOperation(replaceRange, text);
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

	// TODO: Will this end up appending e.g. comment characters when moving past a comment?
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

	private matchEnterRuleMovingDown(model: IVirtualModel, indentConverter: IIndentConverter, tabSize: number, line: number, nextLine: number, nextLineText: string) {
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

	private matchEnterRuleMoveingUp(model: IVirtualModel, indentConverter: IIndentConverter, tabSize: number, line: number, prevLine: number, prevLineText: string) {
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

	public computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		// TODO: Re-implement this
		/*
		let result = helper.getTrackedSelection(this._selectionId!);

		if (this._moveEndLineSelectionShrink && result.startLineNumber < result.endLineNumber) {
			result = result.setEndPosition(result.endLineNumber, 2);
		}
		*/

		const offset = this._isMovingDown ? 1 : -1;
		const s = this._selection;
		const result = new Selection(s.startLineNumber + offset, s.startColumn, s.endLineNumber + offset, s.endColumn);

		return result;
	}
}
