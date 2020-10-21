import { EventEmitter } from 'events';
import { Command } from 'ioredis';
import * as commands from './commands';
import * as commandsStream from './commands-stream';
import createCommand from './command';
import createData from './data';
import createExpires from './expires';
import emitConnectEvent from './commands-utils/emitConnectEvent';
import Pipeline from './pipeline';
import promiseContainer from './promise-container';
import parseKeyspaceEvents from './keyspace-notifications';

const defaultOptions = {
  data: {},
  keyPrefix: '',
  lazyConnect: false,
  notifyKeyspaceEvents: '', // string pattern as specified in https://redis.io/topics/notifications#configuration e.g. 'gxK'
};

const getKeyFromRedisConfig = (options = {}) => {
  const { host = 'localhost', port = '6379' } = options;

  return `${host}:${port}`;
};

const RedisContextMap = new Map();

class RedisMock extends EventEmitter {
  static get Promise() {
    return promiseContainer.get();
  }

  static set Promise(lib) {
    return promiseContainer.set(lib);
  }

  constructor(options = {}) {
    super();

    this.batch = undefined;
    this.connected = false;
    this.subscriberMode = false;

    // eslint-disable-next-line prefer-object-spread
    const optionsWithDefault = Object.assign({}, defaultOptions, options);

    this.expires = createExpires(optionsWithDefault.keyPrefix);

    this.data = createData(
      this.expires,
      optionsWithDefault.data,
      optionsWithDefault.keyPrefix
    );

    this.keyData = getKeyFromRedisConfig(options);

    if (!RedisContextMap.get(this.keyData)) {
      const expires = createExpires(optionsWithDefault.keyPrefix);

      const context = {
        channels: new EventEmitter(),
        expires,
        data: createData(
          expires,
          optionsWithDefault.data,
          optionsWithDefault.keyPrefix
        ),
        patternChannels: new EventEmitter(),
      };

      RedisContextMap.set(this.keyData, context);
    }

    this._initCommands();

    this.keyspaceEvents = parseKeyspaceEvents(
      optionsWithDefault.notifyKeyspaceEvents
    );

    if (optionsWithDefault.lazyConnect === false) {
      this.connected = true;
      emitConnectEvent(this);
    }
  }

  get channels() {
    return RedisContextMap.get(this.keyData).channels;
  }

  set channels(channels) {
    const oldContext = RedisContextMap.get(this.keyData);

    const newContext = {
      ...oldContext,
      channels,
    };

    RedisContextMap.set(this.keyData, newContext);
  }

  get expires() {
    return RedisContextMap.get(this.keyData).expires;
  }

  set expires(expires) {
    const oldContext = RedisContextMap.get(this.keyData);

    const newContext = {
      ...oldContext,
      expires,
    };

    RedisContextMap.set(this.keyData, newContext);
  }

  get data() {
    return RedisContextMap.get(this.keyData).data;
  }

  set data(data) {
    const oldContext = RedisContextMap.get(this.keyData);

    const newContext = {
      ...oldContext,
      data,
    };

    RedisContextMap.set(this.keyData, newContext);
  }

  get patternChannels() {
    return RedisContextMap.get(this.keyData).patternChannels;
  }

  set patternChannels(patternChannels) {
    const oldContext = RedisContextMap.get(this.keyData);

    const newContext = {
      ...oldContext,
      patternChannels,
    };

    RedisContextMap.set(this.keyData, newContext);
  }

  multi(batch = []) {
    this.batch = new Pipeline(this);
    // eslint-disable-next-line no-underscore-dangle
    this.batch._transactions += 1;

    batch.forEach(([command, ...options]) => this.batch[command](...options));

    return this.batch;
  }

  pipeline(batch = []) {
    this.batch = new Pipeline(this);

    batch.forEach(([command, ...options]) => this.batch[command](...options));

    return this.batch;
  }

  exec(callback) {
    const Promise = promiseContainer.get();

    if (!this.batch) {
      return Promise.reject(new Error('ERR EXEC without MULTI'));
    }
    const pipeline = this.batch;
    this.batch = undefined;
    return pipeline.exec(callback);
  }

  createConnectedClient(options = {}) {
    const mock = new RedisMock(options);
    mock.expires =
      typeof options.keyPrefix === 'string'
        ? this.expires.withKeyPrefix(options.keyPrefix)
        : this.expires;
    mock.data =
      typeof options.keyPrefix === 'string'
        ? this.data.withKeyPrefix(options.keyPrefix)
        : this.data;
    mock.channels = this.channels;
    mock.patternChannels = this.patternChannels;
    return mock;
  }

  // eslint-disable-next-line class-methods-use-this
  disconnect() {
    // no-op
  }

  _initCommands() {
    Object.keys(commands).forEach((command) => {
      const commandName = command === 'evaluate' ? 'eval' : command;
      this[commandName] = createCommand(
        commands[command].bind(this),
        commandName,
        this
      );
    });

    Object.keys(commandsStream).forEach((command) => {
      this[command] = commandsStream[command].bind(this);
    });
  }
}
RedisMock.prototype.Command = {
  // eslint-disable-next-line no-underscore-dangle
  transformers: Command._transformer,
  setArgumentTransformer: (name, func) => {
    RedisMock.prototype.Command.transformers.argument[name] = func;
  },

  setReplyTransformer: (name, func) => {
    RedisMock.prototype.Command.transformers.reply[name] = func;
  },
};
module.exports = RedisMock;
