// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
/**
 *
 *
 * @module codecell
 * @namespace codecell
 * @class CodeCell
 */
"use strict";
var outputarea = require('jupyter-js-output-area');
var utils = require('./utils');
var keyboard = require('./keyboard');
var cell = require('./cell');
var completer = require('./completer');
var celltoolbar = require('./celltoolbar');
var $ = require('jquery');
var Cell = cell.Cell;
/* local util for codemirror */
var posEq = function (a, b) { return a.line === b.line && a.ch === b.ch; };
/**
 *
 * function to delete until previous non blanking space character
 * or first multiple of 4 tabstop.
 * @private
 */
CodeMirror.commands.delSpaceToPrevTabStop = function (cm) {
    var from = cm.getCursor(true), to = cm.getCursor(false), sel = !posEq(from, to);
    if (!posEq(from, to)) {
        cm.replaceRange("", from, to);
        return;
    }
    var cur = cm.getCursor(), line = cm.getLine(cur.line);
    var tabsize = cm.getOption('tabSize');
    var chToPrevTabStop = cur.ch - (Math.ceil(cur.ch / tabsize) - 1) * tabsize;
    from = { ch: cur.ch - chToPrevTabStop, line: cur.line };
    var select = cm.getRange(from, cur);
    if (select.match(/^\ +$/) !== null) {
        cm.replaceRange("", from, cur);
    }
    else {
        cm.deleteH(-1, "char");
    }
};
var keycodes = keyboard.keycodes;
exports.CodeCell = function (kernel, options) {
    /**
     * Constructor
     *
     * A Cell conceived to write code.
     *
     * Parameters:
     *  kernel: Kernel instance
     *  options: dictionary
     *      Dictionary of keyword arguments.
     *          events: $(Events) instance
     *          config: dictionary
     *          keyboard_manager: KeyboardManager instance
     *          notebook: Notebook instance
     *          tooltip: Tooltip instance
     */
    this.kernel = kernel;
    this.collapsed = false;
    this.events = options.events;
    this.tooltip = options.tooltip;
    // create all attributed in constructor function
    // even if null for V8 VM optimisation
    this.input_prompt_number = null;
    this.celltoolbar = null;
    this.last_msg_id = null;
    this.completer = null;
    Cell.apply(this, [{
            config: $.extend({}, exports.CodeCell.options_default),
            keyboard_manager: options.keyboard_manager,
            events: this.events }]);
    // Attributes we want to override in this subclass.
    this.cell_type = "code";
    var that = this;
    this.element.focusout(function () { that.auto_highlight(); });
};
exports.CodeCell.options_default = {
    cm_config: {
        extraKeys: {
            "Tab": "indentMore",
            "Shift-Tab": "indentLess",
            "Backspace": "delSpaceToPrevTabStop",
            "Cmd-/": "toggleComment",
            "Ctrl-/": "toggleComment"
        },
        mode: 'text',
        theme: 'ipython',
        matchBrackets: true,
        autoCloseBrackets: true
    },
    highlight_modes: {
        'magic_javascript': { 'reg': ['^%%javascript'] },
        'magic_perl': { 'reg': ['^%%perl'] },
        'magic_ruby': { 'reg': ['^%%ruby'] },
        'magic_python': { 'reg': ['^%%python3?'] },
        'magic_shell': { 'reg': ['^%%bash'] },
        'magic_r': { 'reg': ['^%%R'] },
        'magic_text/x-cython': { 'reg': ['^%%cython'] },
    },
};
exports.CodeCell.config_defaults = exports.CodeCell.options_default;
exports.CodeCell.msg_cells = {};
exports.CodeCell.prototype = Object.create(Cell.prototype);
/** @method create_element */
exports.CodeCell.prototype.create_element = function () {
    Cell.prototype.create_element.apply(this, arguments);
    var that = this;
    var cell = $('<div></div>').addClass('cell code_cell');
    cell.attr('tabindex', '2');
    var input = $('<div></div>').addClass('input');
    this.input = input;
    var prompt = $('<div/>').addClass('prompt input_prompt');
    var inner_cell = $('<div/>').addClass('inner_cell');
    this.celltoolbar = new celltoolbar.CellToolbar({
        cell: this,
        notebook: this.notebook });
    inner_cell.append(this.celltoolbar.element);
    var input_area = $('<div/>').addClass('input_area');
    this.code_mirror = new CodeMirror(input_area.get(0), this._options.cm_config);
    this.code_mirror.setOption("mode", "python");
    // In case of bugs that put the keyboard manager into an inconsistent state,
    // ensure KM is enabled when CodeMirror is focused:
    this.code_mirror.on('focus', function () {
        if (that.keyboard_manager) {
            that.keyboard_manager.enable();
        }
    });
    this.code_mirror.on('keydown', $.proxy(this.handle_keyevent, this));
    $(this.code_mirror.getInputField()).attr("spellcheck", "false");
    inner_cell.append(input_area);
    input.append(prompt).append(inner_cell);
    this.element = cell;
    this.output_model = new outputarea.OutputModel();
    this.output_view = new outputarea.OutputView(this.output_model, document);
    this.output_view.el.className = 'output_area';
    var output_area = $('<div/>').addClass('output_area');
    var output_prompt = $('<div/>').addClass('prompt output_prompt');
    output_area.append(output_prompt);
    output_area.append(this.output_view.el);
    cell.append(input).append(output_area);
    this.completer = new completer.Completer(this, this.events);
};
/** @method bind_events */
exports.CodeCell.prototype.bind_events = function () {
    Cell.prototype.bind_events.apply(this);
    var that = this;
    this.element.focusout(function () { that.auto_highlight(); });
};
/**
 *  This method gets called in CodeMirror's onKeyDown/onKeyPress
 *  handlers and is used to provide custom key handling. Its return
 *  value is used to determine if CodeMirror should ignore the event:
 *  true = ignore, false = don't ignore.
 *  @method handle_codemirror_keyevent
 */
exports.CodeCell.prototype.handle_codemirror_keyevent = function (editor, event) {
    var that = this;
    // whatever key is pressed, first, cancel the tooltip request before
    // they are sent, and remove tooltip if any, except for tab again
    var tooltip_closed = null;
    if (event.type === 'keydown' && event.which !== keycodes.tab) {
        tooltip_closed = this.tooltip.remove_and_cancel_tooltip();
    }
    var cur = editor.getCursor();
    if (event.keyCode === keycodes.enter) {
        this.auto_highlight();
    }
    if (event.which === keycodes.down && event.type === 'keypress' && this.tooltip.time_before_tooltip >= 0) {
        // triger on keypress (!) otherwise inconsistent event.which depending on plateform
        // browser and keyboard layout !
        // Pressing '(' , request tooltip, don't forget to reappend it
        // The second argument says to hide the tooltip if the docstring
        // is actually empty
        this.tooltip.pending(that, true);
    }
    else if (tooltip_closed && event.which === keycodes.esc && event.type === 'keydown') {
        // If tooltip is active, cancel it.  The call to
        // remove_and_cancel_tooltip above doesn't pass, force=true.
        // Because of this it won't actually close the tooltip
        // if it is in sticky mode. Thus, we have to check again if it is open
        // and close it with force=true.
        if (!this.tooltip._hidden) {
            this.tooltip.remove_and_cancel_tooltip(true);
        }
        // If we closed the tooltip, don't let CM or the global handlers
        // handle this event.
        event.codemirrorIgnore = true;
        event._ipkmIgnore = true;
        event.preventDefault();
        return true;
    }
    else if (event.keyCode === keycodes.tab && event.type === 'keydown' && event.shiftKey) {
        if (editor.somethingSelected() || editor.getSelections().length !== 1) {
            var anchor = editor.getCursor("anchor");
            var head = editor.getCursor("head");
            if (anchor.line !== head.line) {
                return false;
            }
        }
        var pre_cursor = editor.getRange({ line: cur.line, ch: 0 }, cur);
        if (pre_cursor.trim() === "") {
            // Don't show tooltip if the part of the line before the cursor
            // is empty.  In this case, let CodeMirror handle indentation.
            return false;
        }
        this.tooltip.request(that);
        event.codemirrorIgnore = true;
        event.preventDefault();
        return true;
    }
    else if (event.keyCode === keycodes.tab && event.type === 'keydown') {
        // Tab completion.
        this.tooltip.remove_and_cancel_tooltip();
        // completion does not work on multicursor, it might be possible though in some cases
        if (editor.somethingSelected() || editor.getSelections().length > 1) {
            return false;
        }
        var pre_cursor = editor.getRange({ line: cur.line, ch: 0 }, cur);
        if (pre_cursor.trim() === "") {
            // Don't autocomplete if the part of the line before the cursor
            // is empty.  In this case, let CodeMirror handle indentation.
            return false;
        }
        else {
            event.codemirrorIgnore = true;
            event.preventDefault();
            this.completer.startCompletion();
            return true;
        }
    }
    // keyboard event wasn't one of those unique to code cells, let's see
    // if it's one of the generic ones (i.e. check edit mode shortcuts)
    return Cell.prototype.handle_codemirror_keyevent.apply(this, [editor, event]);
};
// Kernel related calls.
exports.CodeCell.prototype.set_kernel = function (kernel) {
    this.kernel = kernel;
};
/**
 * Execute current code cell to the kernel
 * @method execute
 */
exports.CodeCell.prototype.execute = function (stop_on_error) {
    var _this = this;
    this.output_model.state = [];
    if (stop_on_error === undefined) {
        stop_on_error = true;
    }
    if (this.get_text().trim().length === 0) {
        // nothing to do
        this.set_input_prompt(null);
        return;
    }
    this.set_input_prompt('*');
    this.element.addClass("running");
    var options = {
        code: this.get_text(),
        silent: false,
        store_history: true,
        stop_on_error: stop_on_error
    };
    var future = this.kernel.execute(options);
    future.onReply = function (msg) {
        _this._handle_execute_reply(msg);
        /*s
        payload : {
                set_next_input : $.proxy(this._handle_set_next_input, this),
                page : $.proxy(this._open_with_pager, this)
            }
        */
    };
    future.onIOPub = function (msg) {
        _this.output_model.consumeMessage(msg);
    };
    future.onInput = function (msg) {
        _this._handle_input_request(msg);
    };
    this.render();
    this.events.trigger('execute.CodeCell', { cell: this });
};
exports.CodeCell.prototype._open_with_pager = function (payload) {
    this.events.trigger('open_with_text.Pager', payload);
};
/**
 * @method _handle_execute_reply
 * @private
 */
exports.CodeCell.prototype._handle_execute_reply = function (msg) {
    this.set_input_prompt(msg.content.execution_count);
    this.element.removeClass("running");
    this.events.trigger('set_dirty.Notebook', { value: true });
};
/**
 * @method _handle_set_next_input
 * @private
 */
exports.CodeCell.prototype._handle_set_next_input = function (payload) {
    var data = { 'cell': this, 'text': payload.text, replace: payload.replace };
    this.events.trigger('set_next_input.Notebook', data);
};
/**
 * @method _handle_input_request
 * @private
 */
exports.CodeCell.prototype._handle_input_request = function (msg) {
    //this.output_area.append_raw_input(msg);
};
// Basic cell manipulation.
exports.CodeCell.prototype.select = function () {
    var cont = Cell.prototype.select.apply(this);
    if (cont) {
        this.code_mirror.refresh();
        this.auto_highlight();
    }
    return cont;
};
exports.CodeCell.prototype.render = function () {
    var cont = Cell.prototype.render.apply(this);
    // Always execute, even if we are already in the rendered state
    return cont;
};
exports.CodeCell.prototype.select_all = function () {
    var start = { line: 0, ch: 0 };
    var nlines = this.code_mirror.lineCount();
    var last_line = this.code_mirror.getLine(nlines - 1);
    var end = { line: nlines - 1, ch: last_line.length };
    this.code_mirror.setSelection(start, end);
};
exports.CodeCell.prototype.collapse_output = function () {
    //this.output_area.collapse();
};
exports.CodeCell.prototype.expand_output = function () {
    //this.output_area.expand();
    //this.output_area.unscroll_area();
};
exports.CodeCell.prototype.scroll_output = function () {
    //this.output_area.expand();
    //this.output_area.scroll_if_long();
};
exports.CodeCell.prototype.toggle_output = function () {
    //this.output_area.toggle_output();
};
exports.CodeCell.prototype.toggle_output_scroll = function () {
    //this.output_area.toggle_scroll();
};
exports.CodeCell.input_prompt_classical = function (prompt_value, lines_number) {
    var ns;
    if (prompt_value === undefined || prompt_value === null) {
        ns = "&nbsp;";
    }
    else {
        ns = encodeURIComponent(prompt_value);
    }
    return 'In&nbsp;[' + ns + ']:';
};
exports.CodeCell.input_prompt_continuation = function (prompt_value, lines_number) {
    var html = [exports.CodeCell.input_prompt_classical(prompt_value, lines_number)];
    for (var i = 1; i < lines_number; i++) {
        html.push(['...:']);
    }
    return html.join('<br/>');
};
exports.CodeCell.input_prompt_function = exports.CodeCell.input_prompt_classical;
exports.CodeCell.prototype.set_input_prompt = function (number) {
    var nline = 1;
    if (this.code_mirror !== undefined) {
        nline = this.code_mirror.lineCount();
    }
    this.input_prompt_number = number;
    var prompt_html = exports.CodeCell.input_prompt_function(this.input_prompt_number, nline);
    // This HTML call is okay because the user contents are escaped.
    this.element.find('div.input_prompt').html(prompt_html);
};
exports.CodeCell.prototype.clear_input = function () {
    this.code_mirror.setValue('');
};
exports.CodeCell.prototype.get_text = function () {
    return this.code_mirror.getValue();
};
exports.CodeCell.prototype.set_text = function (code) {
    return this.code_mirror.setValue(code);
};
exports.CodeCell.prototype.clear_output = function (wait) {
    this.output_model.state = [];
    this.set_input_prompt();
};
// JSON serialization
exports.CodeCell.prototype.fromJSON = function (data) {
    return;
    Cell.prototype.fromJSON.apply(this, arguments);
    if (data.cell_type === 'code') {
        if (data.source !== undefined) {
            this.set_text(data.source);
            // make this value the starting point, so that we can only undo
            // to this state, instead of a blank cell
            this.code_mirror.clearHistory();
            this.auto_highlight();
        }
        this.set_input_prompt(data.execution_count);
    }
};
exports.CodeCell.prototype.toJSON = function () {
    return;
    var data = Cell.prototype.toJSON.apply(this);
    data.source = this.get_text();
    // is finite protect against undefined and '*' value
    if (isFinite(this.input_prompt_number)) {
        data.execution_count = this.input_prompt_number;
    }
    else {
        data.execution_count = null;
    }
    var outputs = this.output_area.toJSON();
    data.outputs = outputs;
    /*
    data.metadata.trusted = this.output_area.trusted;
    data.metadata.collapsed = this.output_area.collapsed;
    if (this.output_area.scroll_state === 'auto') {
        delete data.metadata.scrolled;
    } else {
        data.metadata.scrolled = this.output_area.scroll_state;
    }
    return data;
    */
};
/**
 * handle cell level logic when the cursor moves away from a cell
 * @method unselect
 * @return is the action being taken
 */
exports.CodeCell.prototype.unselect = function (leave_selected) {
    var cont = Cell.prototype.unselect.apply(this, [leave_selected]);
    if (cont) {
        // When a code cell is unselected, make sure that the corresponding
        // tooltip and completer to that cell is closed.
        this.tooltip.remove_and_cancel_tooltip(true);
        if (this.completer !== null) {
            this.completer.close();
        }
    }
    return cont;
};
//# sourceMappingURL=codecell.js.map