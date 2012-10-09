"use strict";

var cli = require("cli");
var path = require("path");
var shjs = require("shelljs");
var minimatch = require("minimatch");
var JSHINT = require("../stable/jshint.js").JSHINT;
var defReporter = require("../reporters/default").reporter;

var OPTIONS = {
	"config": ["config", "Custom configuration file", "string", false ],
	"reporter": ["reporter", "Custom reporter", "string", undefined ],
	"show-non-errors": ["show-non-errors", "Show additional data generated by jshint"],
	"extra-ext": ["extra-ext",
		"Comma-separated list of file extensions to use (default is .js)", "string", ""],

	// Deprecated options.
	"jslint-reporter": [
		"jslint-reporter",
		deprecated("Use a jslint compatible reporter", "--reporter=jslint")
	],

	"checkstyle-reporter": [
		"checkstyle-reporter",
		deprecated("Use a CheckStyle compatible XML reporter", "--reporter=checkstyle")
	]
};

/**
 * Returns the same text but with a deprecation notice.
 * Useful for options descriptions.
 *
 * @param {string} text
 * @param {string} alt (optional) Alternative command to include in the
 *								 deprecation notice.
 *
 * @returns {string}
 */
function deprecated(text, alt) {
	if (!alt) {
		return text + " (DEPRECATED)";
	}

	return text + " (DEPRECATED, use " + alt + " instead)";
}

/**
 * Removes JavaScript comments from a string by replacing
 * everything between block comments and everything after
 * single-line comments in a non-greedy way.
 *
 * English version of the regex:
 *   match '/*'
 *   then match zero or more instances of any character (incl. \n)
 *   except for instances of '* /' (without a space, obv.)
 *   then match '* /' (again, without a space)
 *
 * @param {string} str a string with potential JavaScript comments.
 * @returns {string} a string without JavaScript comments.
 */
function removeComments(str) {
	str = str || "";

	str = str.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, "");
	str = str.replace(/\/\/[^\n\r]*/g, ""); // Everything after '//'

	return str;
}

/**
 * Loads and parses a configuration file.
 *
 * @param {string} fp a path to the config file
 * @returns {object} config object
 */
function loadConfig(fp) {
	if (fp && shjs.test("-e", fp)) {
		return JSON.parse(removeComments(shjs.cat(fp)));
	}

	return {};
}

/**
 * Tries to find a configuration file in either project directory
 * or in the home directory. Configuration files are named
 * '.jshintrc'.
 *
 * @returns {string} a path to the config file
 */
function findConfig() {
	var name = ".jshintrc";
	var proj = findFile(name);
	var home = path.normalize(path.join(process.env.HOME, name));

	if (proj) {
		return proj;
	}

	if (shjs.test("-e", home)) {
		return home;
	}

	return null;
}

/**
 * Tries to import a reporter file and returns its reference.
 *
 * @param {string} fp a path to the reporter file
 * @returns {object} imported module for the reporter or 'null'
 *									 if a module cannot be imported.
 */
function loadReporter(fp) {
	try {
		return require(fp).reporter;
	} catch (err) {
		return null;
	}
}

/**
 * Searches for a file with a specified name starting with
 * 'dir' and going all the way up either until it finds the file
 * or hits the root.
 *
 * @param {string} name filename to search for (e.g. .jshintrc)
 * @param {string} dir  directory to start search from (default:
 *										  current working directory)
 *
 * @returns {string} normalized filename
 */
function findFile(name, dir) {
	dir = dir || process.cwd();

	var filename = path.normalize(path.join(dir, name));
	var parent = path.resolve(dir, "../../");

	if (shjs.test("-e", filename)) {
		return filename;
	}

	if (dir === parent) {
		return null;
	}

	return findFile(name, parent);
}

/**
 * Loads a list of files that have to be skipped. JSHint assumes that
 * the list is located in a file called '.jshintignore'.
 *
 * @return {array} a list of files to ignore.
 */
function loadIgnores() {
	var file = findFile(".jshintignore");

	if (!file) {
		return;
	}

	return shjs.cat(file).split("\n")
		.filter(function (line) {
			return !!line.trim();
		})
		.map(function (line) {
			return path.resolve(path.dirname(file), line.trim());
		});
}

/**
 * Checks whether we should ignore a file or not.
 *
 * @param {string} fp       a path to a file
 * @param {array}  patterns a list of patterns for files to ignore
 *
 * @return {boolean} 'true' if file should be ignored, 'false' otherwise.
 */
function isIgnored(fp, patterns) {
	return patterns.some(function (ip) {
		if (minimatch(fp, ip, { nocase: true })) {
			return true;
		}

		if (path.resolve(fp) === ip) {
			return true;
		}

		if (shjs.test("-d", fp) && ip.match(/^[^\/]*\/?$/) &&
			fp.match(new RegExp("^" + ip + ".*"))) {
			return true;
		}
	});
}

/**
 * Recursively gather all files that need to be linted,
 * excluding those that user asked to ignore.
 *
 * @param {string} fp      a path to a file or directory to lint
 * @param {array}  files   a pointer to an array that stores a list of files
 * @param {array}  ignores a list of patterns for files to ignore
 * @param {array}  ext     a list of non-dot-js extensions to lint
 */
function collect(fp, files, ignores, ext) {
	if (ignores && isIgnored(fp, ignores)) {
		return;
	}

	if (shjs.test("-d", fp)) {
		shjs.ls(fp).forEach(function (item) {
			collect(path.join(fp, item), files, ignores, ext);
		});

		return;
	}

	if (fp.match(ext)) {
		files.push(fp);
	}
}

/**
 * Runs JSHint against provided file and saves the result
 *
 * @param {string} file    a path to a file that needs to be linted
 * @param {object} results a pointer to an object with results
 * @param {object} config  an object with JSHint configuration
 * @param {object} data    a pointer to an object with extra data
 */
function lint(file, results, config, data) {
	var buffer;
	var globals;
	var lintData;

	config = config || {};
	config = JSON.parse(JSON.stringify(config));

	try {
		buffer = shjs.cat(file);
	} catch (err) {
		cli.error("Can't open " + file);
		process.exit(1);
	}

	// Remove potential Unicode BOM.
	buffer = buffer.replace(/^\uFEFF/, "");

	if (config.globals) {
		globals = config.globals;
		delete config.globals;
	}

	if (!JSHINT(buffer, config, globals)) {
		JSHINT.errors.forEach(function (err) {
			if (err) {
				results.push({ file: file, error: err });
			}
		});
	}

	lintData = JSHINT.data();

	if (lintData) {
		lintData.file = file;
		data.push(lintData);
	}
}

var exports = {
	/**
	 * Gathers all files that need to be linted, lints them, sends them to
	 * a reporter and returns the overall result.
	 *
	 * @param {object} post-processed options from 'interpret':
	 *								   args     - CLI arguments
	 *								   config   - Configuration object
	 *								   reporter - Reporter function
	 *								   ignores  - A list of files/dirs to ignore
	 *								   extensions - A list of non-dot-js extensions to check
	 *
	 * @returns {bool} 'true' if all files passed and 'false' otherwise.
	 */
	run: function (opts) {
		var files = [];
		var results = [];
		var data = [];
		var reg = new RegExp("\\.(js" +
			(opts.extensions === "" ? "" : "|" +
				opts.extensions.replace(/,/g, "|").replace(/[\. ]/g, "")) + ")$");

		opts.args.forEach(function (target) {
			collect(target, files, opts.ignores, reg);
		});

		files.forEach(function (file) {
			lint(file, results, opts.config, data);
		});

		(opts.reporter || defReporter)(results, data);

		return results.length === 0;
	},

	/**
	 * Main entrance function. Parses arguments and calls 'run' when
	 * its done. This function is called from bin/jshint file.
	 *
	 * @param {object} args, arguments in the process.argv format.
	 */
	interpret: function (args) {
		cli.setArgv(args);
		cli.options = {};

		cli.enable("version", "glob", "help");
		cli.setApp(path.resolve(__dirname + "/../../package.json"));

		var options = cli.parse(OPTIONS);
		var config = loadConfig(options.config || findConfig());

		switch (true) {
		// JSLint reporter
		case options.reporter === "jslint":
		case options["jslint-reporter"]:
			options.reporter = "../reporters/jslint_xml.js";
			break;

		// CheckStyle (XML) reporter
		case options.reporter === "checkstyle":
		case options["checkstyle-reporter"]:
			options.reporter = "../reporters/checkstyle.js";
			break;

		// Reporter that displays additional JSHint data
		case options["show-non-errors"]:
			options.reporter = "../reporters/non_error.js";
			break;

		// Custom reporter
		case options.reporter !== undefined:
			options.reporter = path.resolve(process.cwd(), options.reporter);
		}

		var reporter;
		if (options.reporter) {
			reporter = loadReporter(options.reporter);

			if (reporter === null) {
				cli.error("Can't load reporter file: " + options.reporter);
				process.exit(1);
			}
		}

		var passed = exports.run({
			args: cli.args,
			config: config,
			reporter: reporter,
			ignores: loadIgnores(),
			extensions: options["extra-ext"]
		});

		// Avoid stdout cutoff in Node 0.4.x, also supports 0.5.x.
		// See https://github.com/joyent/node/issues/1669

		function exit() { process.exit(passed ? 0 : 2); }

		try {
			if (!process.stdout.flush()) {
				process.stdout.once("drain", exit);
			} else {
				exit();
			}
		} catch (err) {
			exit();
		}
	}
};

module.exports = exports;
