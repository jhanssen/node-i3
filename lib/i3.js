/*global require, process, Buffer, module*/

const { exec } = require("child_process");
const net = require("net");
const EventEmitter = require("events");

const I3_MAGIC = new Buffer("i3-ipc");
const I3_MESSAGE_HEADER_LENGTH = I3_MAGIC.length + 8;

const commandNameFromCode = "COMMAND GET_WORKSPACES SUBSCRIBE GET_OUTPUTS GET_TREE GET_MARKS GET_BAR_CONFIG GET_VERSION".split(' ');
const commandCodeFromName = {};
commandNameFromCode.forEach(function(name, code) { commandCodeFromName[name] = code; });

const eventNameFromCode = "workspace output mode window barconfig_update binding".split(" ");
const eventCodeFromName = {};
eventNameFromCode.forEach(function(name, code) { eventCodeFromName[name] = code; });

class I3Message {
    constructor(code, payload) {
        if (typeof code == "string") {
            if (code in commandCodeFromName) {
                code = commandCodeFromName[code];
            } else {
                throw `Invalid code ${code}`;
            }
        }

        this.magic = undefined;
        this.payloadLength = 0;
        this.code = (code == undefined) ? -1 : code;
        this.isEvent = false;
        this.payload = payload;
        if (this.code >= 0) {
            this._encode();
        }
    }

    get complete() { return !this._remaining; }

    _setup(buf, client) {
        const off = client._readOffset;
        this.magic = buf.slice(off, I3_MAGIC.length); // TODO assert magic is correct
        this.payloadLength = buf.readUInt32LE(off + I3_MAGIC.length);
        this.code = buf.readUInt16LE(off + I3_MAGIC.length + 4); // TODO UInt31 here?
        this.isEvent = (buf.readUInt8(off + I3_MAGIC.length + 7) & 0x80) == 0x80;

        this._client = client;
        this._remaining = this.payloadLength;
        this._data = buf.slice(off + I3_MAGIC.length + 8, Math.min(buf.length, off + I3_MAGIC.length + 8 + this._remaining));
        this._remaining -= this._data.length;

        if (this._data.length + off + I3_MAGIC.length + 8 < buf.length) {
            // didn't take it all
            client._readOffset = this._data.length + off + I3_MAGIC.length + 8;
        } else {
            client._readOffset = 0;
        }

        // console.log("data after 0", this._data.length, this.payloadLength, buf.length);
        if (!this._remaining) {
            try {
                // console.log("parse 1", this._data.toString());
                this.payload = JSON.parse(this._data.toString());
            } catch (e) {
                this.payload = e;
            }
            this._data = undefined;
        }
    }

    _consume(buf) {
        const num = Math.min(buf.length, this._remaining);
        if (num <= 0) {
            return;
        }
        if (num == buf.length) {
            this._data = Buffer.concat([this._data, buf]);
            this._client._readOffset = 0;
        } else {
            this._data = Buffer.concat([this._data, buf.slice(0, num)]);
            this._client._readOffset = num;
        }
        this._remaining -= num;

        // console.log("data after 1", this._data.length);
        if (!this._remaining) {
            try {
                // console.log("parse 2", this._data.toString());
                this.payload = JSON.parse(this._data.toString());
            } catch (e) {
                this.payload = e;
            }
            this._data = undefined;
        }
    }

    _encode() {
        let payload;
        if (this.payload === undefined) {
            payload = "";
        } else if (typeof this.payload === "string") {
            payload = this.payload;
        } else {
            payload = JSON.stringify(this.payload);
        }
        const payloadOffset = I3_MAGIC.length + 8;

        let buf = new Buffer(payloadOffset + payload.length);
        I3_MAGIC.copy(buf);
        buf.writeUInt32LE(payload.length, 6);
        buf.writeUInt32LE(this.code, 10);
        if (payload.length > 0) {
            buf.write(payload, payloadOffset);
        }

        this._data = buf;
    }
}

class I3 extends EventEmitter {
    constructor() {
        super();

        this._readOffset = 0;
        this._readBuffers = [];
        this._writeBuffers = [];
        this._length = 0;
        this._requests = [];
        this._full = false;
        this._msg = undefined;
        this._subscribed = new Set();

        this.on("newListener", (event, listener) => {
            //console.log('new listener for', event, eventCodeFromName, event in eventCodeFromName, this._subscribed.has(event));
            if (event in eventCodeFromName && !this._subscribed.has(event)) {
                // subscribe to event
                this._subscribed.add(event);
                this.send(new I3Message("SUBSCRIBE", [event]));
            }
        });
    }

    open(opts) {
        opts = opts || {};
        const connect = path => {
            return new Promise((resolve, reject) => {
                this._socket = net.connect(path, () => {
                    resolve();
                });
                this._socket.once("close", () => {
                    this.emit("close");
                });
                this._socket.once("error", err => {
                    this.emit("error", err);
                });
                this._socket.on("data", data => {
                    this._process(data);
                });
                this._socket.on("drain", () => {
                    this._full = false;
                    this._write();
                });
                this._socket.once("timeout", () => {
                    this._socket.close();
                    this.emit("close");
                });
            });
        };
        return new Promise((resolve, reject) => {
            if (!("path" in opts)) {
                exec("i3 --get-socketpath", (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    connect(stdout.trim()).then(resolve).catch(reject);
                });
            } else {
                connect(opts.path).then(resolve).catch(reject);
            }
        });
    }

    send(msg) {
        return new Promise((resolve, reject) => {
            if (msg instanceof I3Message && msg._data) {
                this._requests.push({ resolve: resolve, reject: reject });
                this._writeBuffers.push(msg._data);
                this._write();
                return;
            } else if (typeof msg == "string" || typeof msg == "number") {
                const nmsg = new I3Message(msg);
                if (nmsg._data) {
                    this._requests.push({ resolve: resolve, reject: reject });
                    this._writeBuffers.push(new I3Message(msg)._data);
                    this._write();
                    return;
                }
            }
            reject("No data");
        });
    }

    _write() {
        if (this._full)
            return;
        let ok;
        for (;;) {
            if (!this._writeBuffers.length)
                return;
            const buf = this._writeBuffers.shift();
            if (!this._socket.write(buf)) {
                this._full = true;
                return;
            }
        }
    }

    _process(buf) {
        if (buf) {
            this._readBuffers.push(buf);
            this._length += buf.length;
        }
        if (this._msg) {
            const nbuf = Buffer.concat(this._readBuffers);
            this._msg._consume(nbuf);
            if (this._readOffset > 0) {
                this._readBuffers = [nbuf];
                this._length = nbuf.length;
            } else {
                this._readBuffers = [];
                this._length = 0;
            }
            if (this._msg.complete) {
                this._handle(this._msg);
                this._msg = undefined;

                process.nextTick(() => { this._process(); });
            }
        } else if (this._length >= I3_MESSAGE_HEADER_LENGTH) {
            const nbuf = Buffer.concat(this._readBuffers);
            this._msg = new I3Message();
            this._msg._setup(nbuf, this);
            if (this._readOffset > 0) {
                this._readBuffers = [nbuf];
                this._length = nbuf.length;
            } else {
                this._readBuffers = [];
                this._length = 0;
            }
            if (this._msg.complete) {
                this._handle(this._msg);
                this._msg = undefined;

                process.nextTick(() => { this._process(); });
            }
        }
    }

    _handle(msg) {
        if (msg.isEvent) {
            const n = eventNameFromCode[msg.code];
            if (msg.payload instanceof Error) {
                this.emit("error", msg.payload);
            } else {
                this.emit(n, msg.payload);
            }
        } else {
            const r = this._requests.shift();
            if (msg.payload instanceof Error) {
                r.reject(msg.payload);
            } else {
                r.resolve(msg.payload);
            }
        }
    }
};

I3.Message = I3Message;

module.exports = I3;
