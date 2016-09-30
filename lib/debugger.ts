// Util from NodeJs
import * as util from 'util'

import {ProtractorBrowser} from './browser';
import {Logger} from './logger';
import {Locator} from './locators';
import * as helper from './util';

let logger = new Logger('protractor');

export class Debugger {
  static init(browser: ProtractorBrowser, debuggerClientPath: string, onStartFn: Function, opt_debugPort?: number) {
  webdriver.promise.ControlFlow.prototype.getControlFlowText = function () {
    let controlFlowText = this.getSchedule(/* opt_includeStackTraces */ true);
    // This filters the entire control flow text, not just the stack trace, so
    // unless we maintain a good (i.e. non-generic) set of keywords in
    // STACK_SUBSTRINGS_TO_FILTER, we run the risk of filtering out non stack
    // trace. The alternative though, which is to reimplement
    // webdriver.promise.ControlFlow.prototype.getSchedule() here is much
    // hackier, and involves messing with the control flow's internals /
    // private
    // variables.
    return helper.filterStackTrace(controlFlowText);
  };

  let vm_ = require('vm');
  let flow = webdriver.promise.controlFlow();

  interface Context {
    require: any;
    [key: string]: any;
  }
  let context: Context = {require: require};
  global.list = (locator: Locator) => {
    return (<Ptor>global.protractor)
        .browser.findElements(locator)
        .then((arr: webdriver.WebElement[]) => {
          let found: string[] = [];
          for (let i = 0; i < arr.length; ++i) {
            arr[i].getText().then((text: string) => {
              found.push(text);
            });
          }
          return found;
        });
  };
  for (let key in global) {
    context[key] = global[key];
  }
  let sandbox = vm_.createContext(context);

  let browserUnderDebug = browser;
  let debuggerReadyPromise = webdriver.promise.defer();
  flow.execute(() => {
    process['debugPort'] = opt_debugPort || process['debugPort'];
    browserUnderDebug.validatePortAvailability_(process['debugPort'])
        .then((firstTime: boolean) => {
          onStartFn(firstTime);

          let args = [process.pid, process['debugPort']];
          if (browserUnderDebug.debuggerServerPort_) {
            args.push(browserUnderDebug.debuggerServerPort_);
          }
          let nodedebug =
              require('child_process').fork(debuggerClientPath, args);
          process.on('exit', function () {
            nodedebug.kill('SIGTERM');
          });
          nodedebug
              .on('message',
                  (m: string) => {
                    if (m === 'ready') {
                      debuggerReadyPromise.fulfill();
                    }
                  })
              .on('exit', () => {
                logger.info('Debugger exiting');
                // Clear this so that we know it's ok to attach a debugger
                // again.
                this.dbgCodeExecutor_ = null;
              });
        });
  });

  let pausePromise = flow.execute(function () {
    return debuggerReadyPromise.then(function () {
      // Necessary for backward compatibility with node < 0.12.0
      return browserUnderDebug.executeScript_('', 'empty debugger hook');
    });
  });

  // Helper used only by debuggers at './debugger/modes/*.js' to insert code
  // into the control flow.
  // In order to achieve this, we maintain a promise at the top of the control
  // flow, so that we can insert frames into it.
  // To be able to simulate callback/asynchronous code, we poll this object
  // for an result at every run of DeferredExecutor.execute.
  this.dbgCodeExecutor_ = {
    execPromise_: pausePromise,  // Promise pointing to current stage of flow.
    execPromiseResult_: undefined,  // Return value of promise.
    execPromiseError_: undefined,   // Error from promise.

    // A dummy repl server to make use of its completion function.
    replServer_: require('repl').start({
      input: {
        on: function () {
        },
        resume: function () {
        }
      },                               // dummy readable stream
      output: {
        write: function () {
        }
      },  // dummy writable stream
      useGlobal: true
    }),

    // Execute a function, which could yield a value or a promise,
    // and allow its result to be accessed synchronously
    execute_: function (execFn_: Function) {
      this.execPromiseResult_ = this.execPromiseError_ = undefined;

      this.execPromise_ = this.execPromise_.then(execFn_).then(
          (result: Object) => {
            this.execPromiseResult_ = result;
          },
          (err: Error) => {
            this.execPromiseError_ = err;
          });

      // This dummy command is necessary so that the DeferredExecutor.execute
      // break point can find something to stop at instead of moving on to the
      // next real command.
      this.execPromise_.then(() => {
        return browserUnderDebug.executeScript_('', 'empty debugger hook');
      });
    },

    // Execute a piece of code.
    // Result is a string representation of the evaluation.
    execute: function (code: Function) {
      let execFn_ = () => {
        // Run code through vm so that we can maintain a local scope which is
        // isolated from the rest of the execution.
        let res = vm_.runInContext(code, sandbox);
        if (!webdriver.promise.isPromise(res)) {
          res = webdriver.promise.fulfilled(res);
        }

        return res.then((res: any) => {
          if (res === undefined) {
            return undefined;
          } else {
            // The '' forces res to be expanded into a string instead of just
            // '[Object]'. Then we remove the extra space caused by the ''
            // using
            // substring.
            return util.format.apply(this, ['', res]).substring(1);
          }
        });
      };
      this.execute_(execFn_);
    },

    // Autocomplete for a line.
    // Result is a JSON representation of the autocomplete response.
    complete: function (line: string) {
      let execFn_ = () => {
        let deferred = webdriver.promise.defer();
        this.replServer_.complete(line, (err: any, res: any) => {
          if (err) {
            deferred.reject(err);
          } else {
            deferred.fulfill(JSON.stringify(res));
          }
        });
        return deferred;
      };
      this.execute_(execFn_);
    },

    // Code finished executing.
    resultReady: function () {
      return !this.execPromise_.isPending();
    },

    // Get asynchronous results synchronously.
    // This will throw if result is not ready.
    getResult: function () {
      if (!this.resultReady()) {
        throw new Error('Result not ready');
      }
      if (this.execPromiseError_) {
        throw this.execPromiseError_;
      }
      return this.execPromiseResult_;
    }
  };

  return pausePromise;
}

