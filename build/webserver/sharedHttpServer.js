"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sharedHttpServer_exports = {};
__export(sharedHttpServer_exports, {
  SharedHttpServer: () => SharedHttpServer
});
module.exports = __toCommonJS(sharedHttpServer_exports);
var import_node_http = require("node:http");
var import_node_https = require("node:https");
class SharedHttpServer {
  options;
  server = null;
  handlers = [];
  constructor(options) {
    this.options = options;
  }
  registerHandler(name, matches, handler) {
    this.handlers.push({ name, matches, handler });
  }
  get scheme() {
    return this.options.tls ? "https" : "http";
  }
  /** Number of registered handlers — a server without handlers has nothing to serve. */
  get handlerCount() {
    return this.handlers.length;
  }
  /**
   * The port the server listens on — the one the OS picked when it was configured as 0 (tests bind
   * to port 0 instead of probing for a free port and hoping it stays free).
   */
  get port() {
    var _a;
    const address = (_a = this.server) == null ? void 0 : _a.address();
    return address && typeof address === "object" ? address.port : this.options.port;
  }
  /** Whether the server is listening. */
  get listening() {
    return this.server !== null;
  }
  start() {
    return new Promise((resolve, reject) => {
      const handler = (req, res) => {
        void this.dispatch(req, res);
      };
      const server = this.options.tls ? (0, import_node_https.createServer)(
        { key: this.options.tls.key, cert: this.options.tls.cert, ca: this.options.tls.ca },
        handler
      ) : (0, import_node_http.createServer)(handler);
      server.once("error", reject);
      const onListening = () => {
        server.removeListener("error", reject);
        server.on("error", (err) => {
          this.options.logger.warn(`Shared ${this.scheme} server error: ${err.message}`);
        });
        server.on("clientError", (err, socket) => {
          if (socket.writable) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          } else {
            socket.destroy();
          }
          this.options.logger.debug(`Shared ${this.scheme} server: client error: ${err.message}`);
        });
        this.server = server;
        const where = this.options.ip ? `${this.options.ip}:${this.port}` : `:${this.port}`;
        this.options.logger.info(`Shared ${this.scheme} server listening on ${where}`);
        resolve();
      };
      if (this.options.ip) {
        server.listen(this.options.port, this.options.ip, onListening);
      } else {
        server.listen(this.options.port, onListening);
      }
    });
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = null;
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  async dispatch(req, res) {
    for (const entry of this.handlers) {
      let isMatch = false;
      try {
        isMatch = entry.matches(req);
      } catch (err) {
        this.options.logger.warn(`Handler ${entry.name} match check failed: ${err.message}`);
      }
      if (!isMatch) {
        continue;
      }
      try {
        const handled = await entry.handler(req, res);
        if (handled === false) {
          continue;
        }
        return;
      } catch (err) {
        this.options.logger.warn(`Handler ${entry.name} threw: ${err.message}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
        return;
      }
    }
    res.statusCode = 404;
    res.end();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SharedHttpServer
});
//# sourceMappingURL=sharedHttpServer.js.map
