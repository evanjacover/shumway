/* -*- mode: javascript; tab-width: 4; indent-tabs-mode: nil -*- */

var isAVM1TraceEnabled = false;

function AS2ScopeListItem(scope, next) {
  this.scope = scope;
  this.next = next;
}
AS2ScopeListItem.prototype = {
  create: function (scope) {
    return new AS2ScopeListItem(scope, this);
  }
};

function AS2Context(swfVersion) {
  this.swfVersion = swfVersion;
  this.globals = new AS2Globals(this);
  var windowScope = new AS2ScopeListItem(window, null);
  this.initialScope = new AS2ScopeListItem(this.globals, windowScope);
  this.assets = {};
}
AS2Context.instance = null;
AS2Context.prototype = {
  addAssets: function(assets) {
    for (var i = 0; i < assets.length; i++) {
      if (assets[i].className) {
        this.assets[assets[i].className] = assets[i];
      }
    }
  },
  resolveTarget: function(target) {
    if (!target)
      target = this.defaultTarget;
    else if (typeof target === 'string')
      target = this.defaultTarget.$lookupChild(target);
    if (typeof target !== 'object' || !('$nativeObject' in target))
      throw 'Invalid AS2 object';

    return target;
  },
  resolveLevel: function(level) {
    return this.resolveTarget(this.globals['_level' + level]);
  }
};

function executeActions(actionsData, context, scope, assets) {
  var actionTracer = ActionTracerFactory.get();

  var scopeContainer = context.initialScope.create(scope);
  var savedContext = AS2Context.instance;
  try {
    AS2Context.instance = context;
    context.defaultTarget = scope;
    context.globals['this'] = scope;
    if (assets)
      context.addAssets(assets);
    actionTracer.message('ActionScript Execution Starts');
    actionTracer.indent();
    interpretActions(actionsData, scopeContainer, null, []);
  } finally {
    actionTracer.unindent();
    actionTracer.message('ActionScript Execution Stops');
    AS2Context.instance = savedContext;
  }
}

function lookupAS2Children(targetPath, defaultTarget, root) {
  var path = targetPath.split('/');
  if (path[path.length - 1] === '') {
    path.pop();
  }
  var obj = defaultTarget;
  if (path[0] === '') {
    defaultTarget = root;
    path.shift();
  }
  while (path.length > 0) {
    obj = obj.$lookupChild(path[0]);
    if (!obj) {
      throw path[0] + ' is undefined in ' + targetPath;
    }
    path.shift();
  }
  return obj;
}

function interpretActions(actionsData, scopeContainer,
                          constantPool, registers) {
  var currentContext = AS2Context.instance;

  function setTarget(targetPath) {
    if (!targetPath)
      defaultTarget = _global._root;
    else
      defaultTarget = lookupAS2Children(targetPath, defaultTarget, _global._root);
    currentContext.defaultTarget = defaultTarget;
  }

  function defineFunction(functionName, parametersNames,
                          registersAllocation, actionsData) {
    var fn = (function() {
      var newScope = { 'this': this, 'arguments': arguments };
      var newScopeContainer = scopeContainer.create(newScope);

      for (var i = 0; i < arguments.length || i < parametersNames.length; i++)
        newScope[parametersNames[i]] = arguments[i];
      var registers = [];
      if (registersAllocation) {
        for (var i = 0; i < registersAllocation.length; i++) {
          var registerAllocation = registersAllocation[i];
          if (!registerAllocation)
            continue;
          if (registerAllocation.type == 'param') {
            registers[i] = arguments[registerAllocation.index];
          } else { // var
            switch (registerAllocation.name) {
              case 'this':
                registers[i] = this;
                break;
              case 'arguments':
                registers[i] = arguments;
                break;
              case 'super':
                throw 'Not implemented: super';
              case '_global':
                registers[i] = _global;
                break;
              case '_parent':
                registers[i] = _global._parent;
                break;
              case '_root':
                registers[i] = _global._root;
                break;
            }
          }
        }
      }

      var savedContext = AS2Context.instance;
      try
      {
        // switching contexts if called outside main thread
        AS2Context.instance = currentContext;
        currentContext.defaultTarget = scope;
        actionTracer.indent();
        return interpretActions(actionsData, newScopeContainer,
          constantPool, registers);
      } finally {
        actionTracer.unindent();
        currentContext.defaultTarget = defaultTarget;
        AS2Context.instance = savedContext;
      }
    });
    if (functionName)
      fn.name = functionName;
    return fn;
  }
  function deleteProperty(propertyName) {
    for (var p = scopeContainer; p; p = p.next) {
      if (propertyName in p.scope) {
        delete p.scope[propertyName];
        return !(propertyName in p.scope);
      }
    }
    return false;
  }
  function instanceOf(obj, constructor) {
    if (obj instanceof constructor)
      return true;
    // TODO interface check
    return false;
  }
  function isMovieClip(obj) {
    return instanceOf(obj, _global.MovieClip);
  }
  function resolveVariableName(variableName) {
    var obj, name;
    if (variableName.indexOf(':') >= 0) {
      // "/A/B:FOO references the FOO variable in the movie clip with a target path of /A/B."
      var parts = variableName.split(':');
      var obj = lookupAS2Children(parts[0], defaultTarget, _global._root);
      name = parts[1];
    } else if (variableName.indexOf('.') >= 0) {
      // new object reference
      var objPath = variableName.split('.');
      name = objPath.pop();
      var obj = _global;
      for (var i = 0; i < objPath.length; i++) {
        obj = obj[objPath[i]];
        if (!obj) {
          throw objPath.slice(0, i + 1) + ' is undefined';
        }
      }
    }

    if(!obj)
      return; // local variable

    return { obj: obj, name: name };
  }
  function getVariable(variableName) {
    // fast check if variable in the current scope
    if (variableName in scope) {
      return scope[variableName];
    }

    var target = resolveVariableName(variableName);
    if (target)
      return target.obj[target.name];

    var mc = defaultTarget.$lookupChild(variableName);
    if (mc)
      return mc;

    for (var p = scopeContainer; p; p = p.next) {
      if (variableName in p.scope) {
        return p.scope[variableName];
      }
    }
  }
  function setVariable(variableName, value) {
    // fast check if variable in the current scope
    if (variableName in scope) {
      scope[variableName] = value;
      return;
    }

    var target = resolveVariableName(variableName);
    if (target) {
      target.obj[target.name] = value;
      return;
    }
    var _this = scope.this || getVariable('this');
    _this[variableName] = value;
  }
  function getFunction(functionName) {
    var fn = getVariable(functionName);
    if (!(fn instanceof Function))
      throw 'Function "' + functionName + '" is not found';
    return fn;
  }
  function getObjectByName(objectName) {
    var obj = getVariable(objectName);
    if (!(obj instanceof Object))
      throw 'Object "' + objectName + '" is not found';
    return obj;
  }
  function processWith(obj, withBlock) {
    var newScopeContainer = scopeContainer.create(Object(obj));
    interpretActions(withBlock, newScopeContainer, constantPool, registers);
  }
  function processTry(catchIsRegisterFlag, finallyBlockFlag, catchBlockFlag, catchTarget,
                      tryBlock, catchBlock, finallyBlock) {
    try {
      interpretActions(tryBlock, scopeContainer, constantPool, registers);
    } catch (e) {
      if (!catchBlockFlag)
        throw e;
      if (typeof catchTarget === 'string')
        scope[catchTarget] = e;
      else
        registers[catchTarget] = e;
      interpretActions(catchBlock, scopeContainer, constantPool, registers);
    } finally {
      if (finallyBlockFlag)
        interpretActions(finallyBlock, scopeContainer, constantPool, registers);
    }
  }

  var stream = new ActionsDataStream(actionsData, currentContext.swfVersion);
  var _global = currentContext.globals
  var defaultTarget = currentContext.defaultTarget;
  var stack = [];
  var scope = scopeContainer.scope;
  var isSwfVersion5 = currentContext.swfVersion >= 5;
  var actionTracer = ActionTracerFactory.get();

  while (stream.position < stream.end) {
    var actionCode = stream.readUI8();
    var length = actionCode >= 0x80 ? stream.readUI16() : 0;
    var nextPosition = stream.position + length;

    actionTracer.print(stream.position, actionCode, stack);
    switch (actionCode) {
      // SWF 3 actions
      case 0x81: // ActionGotoFrame
        var frame = stream.readUI16();
        _global.gotoAndPlay(frame + 1);
        break;
      case 0x83: // ActionGetURL
        var urlString = stream.readString();
        var targetString = stream.readString();
        _global.getURL(urlString, targetString);
        break;
      case 0x04: // ActionNextFrame
        _global.nextFrame();
        break;
      case 0x05: // ActionPreviousFrame
        _global.prevFrame();
        break;
      case 0x06: // ActionPlay
        _global.play();
        break;
      case 0x07: // ActionStop
        _global.stop();
        break;
      case 0x08: // ActionToggleQuality
        _global.toggleHighQuality();
        break;
      case 0x09: // ActionStopSounds
        _global.stopAllSounds();
        break;
      case 0x8A: // ActionWaitForFrame
        var frame = stream.readUI16();
        var skipCount = stream.readUI8();
        if (!_global.ifFrameLoaded(frame))
          nextPosition += skipCount; // actions or bytes ?
        break;
      case 0x8B: // ActionSetTarget
        var targetName = stream.readString();
        setTarget(targetName);
        break;
      case 0x8C: // ActionGoToLabel
        var label = stream.readString();
        _global.gotoLabel(label);
        break;
      // SWF 4 actions
      case 0x96: // ActionPush
        while (stream.position < nextPosition) {
          var type = stream.readUI8();
          var value;
          switch (type) {
            case 0: // STRING
              value = stream.readString();
              break;
            case 1: // FLOAT
              value = stream.readFloat();
              break;
            case 2: // null
              value = null;
              break;
            case 3: // undefined
              value = void(0);
              break;
            case 4: // Register number
              value = registers[stream.readUI8()];
              break;
            case 5: // Boolean
              value = stream.readBoolean();
              break;
            case 6: // Double
              value = stream.readDouble();
              break;
            case 7: // Integer
              value = stream.readInteger();
              break;
            case 8: // Constant8
              value = constantPool[stream.readUI8()];
              break;
            case 9: // Constant16
              value = constantPool[stream.readUI16()];
              break;
            default:
              throw 'Uknown value type: ' + type;
          }
          stack.push(value);
        }
        break;
      case 0x17: // ActionPop
        stack.pop();
        break;
      case 0x0A: // ActionAdd
        var a = +stack.pop();
        var b = +stack.pop();
        stack.push(a + b);
        break;
      case 0x0B: // ActionSubtract
        var a = +stack.pop();
        var b = +stack.pop();
        stack.push(b - a);
        break;
      case 0x0C: // ActionMultiply
        var a = +stack.pop();
        var b = +stack.pop();
        stack.push(a * b);
        break;
      case 0x0D: // ActionDivide
        var a = +stack.pop();
        var b = +stack.pop();
        var c = b / a;
        stack.push(isSwfVersion5 ? c : isFinite(c) ? c : '#ERROR#');
        break;
      case 0x0E: // ActionEquals
        var a = +stack.pop();
        var b = +stack.pop();
        var f = a == b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x0F: // ActionLess
        var a = +stack.pop();
        var b = +stack.pop();
        var f = b < a;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x10: // ActionAnd
        var a = stack.pop();
        var b = stack.pop();
        var f = a && b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x11: // ActionOr
        var a = stack.pop();
        var b = stack.pop();
        var f = a || b;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x12: // ActionNot
        var f = !stack.pop();
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x13: // ActionStringEquals
        var sa = '' + stack.pop();
        var sb = '' + stack.pop();
        var f = sa == sb;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x14: // ActionStringLength
      case 0x31: // ActionMBStringLength
        stack.push(_global.length(stack.pop()));
        var sa = '' + stack.pop();
        stack.push(sa.length);
        break;
      case 0x21: // ActionStringAdd
        var sa = '' + stack.pop();
        var sb = '' + stack.pop();
        stack.push(sb + sa);
        break;
      case 0x15: // ActionStringExtract
        var count = stack.pop();
        var index = stack.pop();
        var value = stack.pop();
        stack.push(_global.substring(value, index, count));
        break;
      case 0x35: // ActionMBStringExtract
        var count = stack.pop();
        var index = stack.pop();
        var value = stack.pop();
        stack.push(_global.mbsubstring(value, index, count));
        break;
      case 0x29: // ActionStringLess
        var sa = '' + stack.pop();
        var sb = '' + stack.pop();
        var f = sb < sa;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      case 0x18: // ActionToInteger
        stack.push(_global.int(stack.pop()));
        break;
      case 0x32: // ActionCharToAscii
        stack.push(_global.chr(stack.pop()));
        break;
      case 0x36: // ActionMBCharToAscii
        stack.push(_global.mbchr(stack.pop()));
        break;
      case 0x33: // ActionAsciiToChar
        stack.push(_global.ord(stack.pop()));
        break;
      case 0x37: // ActionMBAsciiToChar
        stack.push(_global.mbord(stack.pop()));
        break;
      case 0x99: // ActionJump
        var branchOffset = stream.readSI16();
        nextPosition += branchOffset;
        break;
      case 0x9D: // ActionIf
        var branchOffset = stream.readSI16();
        var f = !!stack.pop();
        if (f)
          nextPosition += branchOffset;
        break;
      case 0x9E: // ActionCall
        var label = stack.pop();
        _global.call(label);
        break;
      case 0x1C: // ActionGetVariable
        var variableName = '' + stack.pop();
        stack.push(getVariable(variableName));
        break;
      case 0x1D: // ActionSetVariable
        var value = stack.pop();
        var variableName = '' + stack.pop();
        setVariable(variableName, value);
        break;
      case 0x9A: // ActionGetURL2
        var flags = stream.readUI8();
        var httpMethod;
        switch ((flags >> 6) & 3) {
          case 1:
            httpMethod = 'GET';
            break;
          case 2:
            httpMethod  = 'POST';
            break;
        }
        var loadMethod = !!(flags & 2) ?
          (!!(flags & 1) ? _global.loadVariables : _global.loadMovie) :
          (!!(flags & 1) ? _global.loadVariablesNum : _global.loadMovieNum);
        var target = stack.pop();
        var url = stack.pop();
        loadMethod.call(_global, url, target, httpMethod);
        break;
      case 0x9F: // ActionGotoFrame2
        var flags = stream.readUI8();
        var gotoParams = [stack.pop()];
        if (!!(flags & 2))
          gotoParams.push(stream.readUI16());
        var gotoMethod = !!(flags & 1) ? _global.gotoAndPlay : _global.gotoAndStop;
        gotoMethod.apply(_global, gotoParams);
        break;
      case 0x20: // ActionSetTarget2
        var target = stack.pop();
        setTarget(target);
        break;
      case 0x22: // ActionGetProperty
        var index = stack.pop();
        var target = stack.pop();
        stack.push(_global.getProperty(target, index));
        break;
      case 0x23: // ActionSetProperty
        var value = stack.pop();
        var index = stack.pop();
        var target = stack.pop();
        _global.setProperty(target, index, value);
        break;
      case 0x24: // ActionCloneSprite
        var depth = stack.pop();
        var target = stack.pop();
        var source = stack.pop();
        _global.duplicateMovieClip(source, target, depth);
        break;
      case 0x25: // ActionRemoveSprite
        var target = stack.pop();
        _global.unloadMovie(target);
        break;
      case 0x27: // ActionStartDrag
        var target = stack.pop();
        var lockcenter = stack.pop();
        var constrain = !stack.pop() ? null : {
          y2: stack.pop(),
          x2: stack.pop(),
          y1: stack.pop(),
          x1: stack.pop()
        };
        dragParams = [target, lockcenter];
        if (constrain) {
          dragParams = dragParams.push(constrain.x1, constrain.y1,
            constrain.x2, constrain.y2);
        }
        _global.startDrag.apply(_global, dragParams);
        break;
      case 0x28: // ActionEndDrag
        _global.stopDrag();
        break;
      case 0x8D: // ActionWaitForFrame2
        var skipCount = stream.readUI8();
        var frame = stack.pop();
        if (!_global.ifFrameLoaded(frame))
          nextPosition += skipCount; // actions or bytes ?
        debugger;
        //_global.waitForFrame(label, skipCount);
        break;
      case 0x26: // ActionTrace
        var value = stack.pop();
        _global.trace(value);
        break;
      case 0x34: // ActionGetTime
        stack.push(_global.getTimer());
        break;
      case 0x30: // ActionRandomNumber
        stack.push(_global.random(stack.pop()));
        break;
      // SWF 5
      case 0x3D: // ActionCallFunction
        var functionName = stack.pop();
        var numArgs = stack.pop();
        var args = [];
        for (var i = 0; i < numArgs; i++)
          args.push(stack.pop());
        var fn = getFunction(functionName);
        var result = fn.apply(scope, args);
        stack.push(result);
        break;
      case 0x52: // ActionCallMethod
        var methodName = stack.pop();
        var obj = stack.pop();
        var numArgs = stack.pop();
        var args = [];
        for (var i = 0; i < numArgs; i++)
          args.push(stack.pop());
        var result;
        if (methodName) {
          obj = Object(obj);
          if (!(methodName in obj))
            throw 'Method ' + methodName + ' is not defined.';
          result = obj[methodName].apply(obj, args);
        } else
          result = obj.apply(defaultTarget, args);
        stack.push(result);
        break;
      case 0x88: // ActionConstantPool
        var count = stream.readUI16();
        constantPool = [];
        for (var i = 0; i < count; i++)
          constantPool.push(stream.readString());
        break;
      case 0x9B: // ActionDefineFunction
        var functionName = stream.readString();
        var numParams = stream.readUI16();
        var functionParams = [];
        for (var i = 0; i < numParams; i++)
          functionParams.push(stream.readString());
        var codeSize = stream.readUI16();
        nextPosition += codeSize;

        var fn = defineFunction(functionName, functionParams, null,
          stream.readBytes(codeSize));
        if (functionName)
          scope[functionName] = fn;
        else
          stack.push(fn);
        break;
      case 0x3C: // ActionDefineLocal
        var value = stack.pop();
        var name = stack.pop();
        scope[name] = value;
        break;
      case 0x41: // ActionDefineLocal2
        var name = stack.pop();
        scope[name] = void(0);
        break;
      case 0x3A: // ActionDelete
        var name = stack.pop();
        var obj = stack.pop();
        delete obj[name];
        stack.push(!(name in obj)); // XXX undocumented ???
        break;
      case 0x3B: // ActionDelete2
        var name = stack.pop();
        var result = deleteProperty(name);
        stack.push(result); // undocumented ???
        break;
      case 0x46: // ActionEnumerate
        var objectName = stack.pop();
        stack.push(null);
        var obj = getObjectByName(objectName);
        for (var name in obj)
          stack.push(name);
        break;
      case 0x49: // ActionEquals2
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg1 == arg2);
        break;
      case 0x4E: // ActionGetMember
        var name = stack.pop();
        var obj = stack.pop();
        stack.push(obj[name]);
        break;
      case 0x42: // ActionInitArray
        var numArgs = stack.pop();
        var arr = [];
        for (var i = 0; i < numArgs; i++)
          arr.push(stack.pop());
        stack.push(arr);
        break;
      case 0x43: // ActionInitObject
        var numArgs = stack.pop();
        var obj = {};
        for (var i = 0; i < numArgs; i++) {
          var value = stack.pop();
          var name = stack.pop();
          obj[name] = value;
        }
        stack.push(obj);
        break;
      case 0x53: // ActionNewMethod
        var methodName = stack.pop();
        var obj = stack.pop();
        var numArgs = stack.pop();
        var args = [];
        for (var i = 0; i < numArgs; i++)
          args.push(stack.pop());
        var method;
        if (methodName) {
          if (!(methodName in obj))
            throw 'Method ' + methodName + ' is not defined.';
          method = obj[methodName];
        } else {
          method = obj;
        }
        // XXX: this is non-semantics-preserving, but it's
        // necessary to make constructors for runtime objects
        // work.
        var result = new (method.bind.apply(method, [null].concat(args)))();
        if (!result) {
          result = {};
          result.constructor = method;
          method.apply(result, args);
        }
        stack.push(result);
        break;
      case 0x40: // ActionNewObject
        var objectName = stack.pop();
        var obj = getObjectByName(objectName);
        var numArgs = stack.pop();
        var args = [];
        for (var i = 0; i < numArgs; i++)
          args.push(stack.pop());
        var result = createBuiltinType(obj, args);
        if (typeof result === 'undefined') {
          // obj in not a built-in type
          result = {};
          obj.apply(result, args);
          result.constructor = obj;
        }
        stack.push(result);
        break;
      case 0x4F: // ActionSetMember
        var value = stack.pop();
        var name = stack.pop();
        var obj = stack.pop();
        obj[name] = value;
        break;
      case 0x45: // ActionTargetPath
        var obj = stack.pop();
        stack.push(isMovieClip(obj) ? obj._target : void(0));
        break;
      case 0x94: // ActionWith
        var codeSize = stream.readUI16();
        var obj = stack.pop();
        nextPosition += codeSize;
        processWith(obj, stream.readBytes(codeSize));
        break;
      case 0x4A: // ActionToNumber
        stack.push(+stack.pop());
        break;
      case 0x4B: // ActionToString
        stack.push("" + stack.pop());
        break;
      case 0x44: // ActionTypeOf
        var obj = stack.pop();
        var result = isMovieClip(obj) ? 'movieclip' : typeof obj;
        stack.push(result);
        break;
      case 0x47: // ActionAdd2
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 + arg1);
        break;
      case 0x48: // ActionLess2
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 < arg1);
        break;
      case 0x3F: // ActionModulo
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 % arg1);
        break;
      case 0x60: // ActionBitAnd
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 & arg1);
        break;
      case 0x63: // ActionBitLShift
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 << arg1);
        break;
      case 0x61: // ActionBitOr
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 | arg1);
        break;
      case 0x64: // ActionBitRShift
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 >> arg1);
        break;
      case 0x65: // ActionBitURShift
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 >>> arg1);
        break;
      case 0x62: // ActionBitXor
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 ^ arg1);
        break;
      case 0x51: // ActionDecrement
        var arg1 = stack.pop();
        arg1--;
        stack.push(arg1);
        break;
      case 0x50: // ActionIncrement
        var arg1 = stack.pop();
        arg1++;
        stack.push(arg1);
        break;
      case 0x4C: // ActionPushDuplicate
        stack.push(stack[stack.length - 1]);
        break;
      case 0x3E: // ActionReturn
        return stack.pop(); // return
      case 0x4D: // ActionStackSwap
        stack.push(stack.pop(), stack.pop());
        break;
      case 0x87: // ActionStoreRegister
        var register = stream.readUI8();
        registers[register] = stack[stack.length - 1];
        break;
      // SWF 6
      case 0x54: // ActionInstanceOf
        var constr = stack.pop();
        var obj = stack.pop();
        stack.push(instanceOf(Object(obj), constr));
        break;
      case 0x55: // ActionEnumerate2
        var obj = stack.pop();
        stack.push(null);
        for (var name in obj)
          stack.push(name);
        break;
      case 0x66: // ActionStrictEquals
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg1 === arg2);
        break;
      case 0x67: // ActionGreater
        var arg1 = stack.pop();
        var arg2 = stack.pop();
        stack.push(arg2 > arg1);
        break;
      case 0x68: // ActionStringGreater
        var sa = '' + stack.pop();
        var sb = '' + stack.pop();
        var f = sb > sa;
        stack.push(isSwfVersion5 ? f : f ? 1 : 0);
        break;
      // SWF 7
      case 0x8E: // ActionDefineFunction2
        var functionName = stream.readString();
        var numParams = stream.readUI16();
        var registerCount = stream.readUI8();
        var flags = stream.readUI16();
        var registerAllocation = [];
        var functionParams = [];
        for (var i = 0; i < numParams; i++) {
          var register = stream.readUI8();
          var paramName = stream.readString();
          functionParams.push(paramName);
          if (register) {
            registerAllocation[register] = {
              type: 'param',
              name: paramName,
              index: i
            };
          }
        }
        var codeSize = stream.readUI16();
        nextPosition += codeSize;

        var j = 1;
        // order this, arguments, super, _root, _parent, and _global
        if (flags & 0x0001) // preloadThis
          registerAllocation[j++] = { type: 'var', name: 'this' };
        if (flags & 0x0004) // preloadArguments
          registerAllocation[j++] = { type: 'var', name: 'arguments' };
        if (flags & 0x0010) // preloadSuper
          registerAllocation[j++] = { type: 'var', name: 'super' };
        if (flags & 0x0040) // preloadRoot
          registerAllocation[j++] = { type: 'var', name: '_root' };
        if (flags & 0x0080) // preloadParent
          registerAllocation[j++] = { type: 'var', name: '_parent' };
        if (flags & 0x0100) // preloadGlobal
          registerAllocation[j++] = { type: 'var', name: '_global' };

        var fn = defineFunction(functionName, functionParams,
          registerAllocation, stream.readBytes(codeSize));
        if (functionName)
          scope[functionName] = fn;
        else
          stack.push(fn);
        break;
      case 0x69: // ActionExtends
        var constrSuper = stack.pop();
        var constrSub = stack.pop();
        var obj = Object.create(constrSuper.prototype, {
          constructor: { value: constrSub, enumerable: false }
        });
        constrSub.prototype = obj;
        break;
      case 0x2B: // ActionCastOp
        var obj =  stack.pop();
        var constr = stack.pop();
        stack.push(instanceOf(obj, constr) ? obj : null);
        break;
      case 0x2C: // ActionImplementsOp
        var constr = stack.pop();
        var interfacesCount = stack.pop();
        var interfaces = [];
        for (var i = 0; i < interfacesCount; i++)
          interfaces.push(stack.pop());
        constr.$interfaces = interfaces;
        break;
      case 0x8F: // ActionTry
        var flags = stream.readUI8();
        var catchIsRegisterFlag = !!(flags & 4);
        var finallyBlockFlag = !!(flags & 2);
        var catchBlockFlag = !!(flags & 1);
        var trySize = stream.readUI16();
        var catchSize = stream.readUI16();
        var finallySize = stream.readUI16();
        var catchTarget = catchIsRegisterFlag ? stream.readUI8() : stream.readString();
        nextPosition += trySize + catchSize + finallySize;
        processTry(catchIsRegisterFlag, finallyBlockFlag, catchBlockFlag, catchTarget,
          stream.readBytes(trySize), stream.readBytes(catchSize), stream.readBytes(finallySize));
        break;
      case 0x2A: // ActionThrow
        var obj = stack.pop();
        throw obj;
      // Not documented by the spec
      case 0x2D: // ActionFSCommand2
        var numArgs = stack.pop();
        var args = [];
        for (var i = 0; i < numArgs; i++)
          args.push(stack.pop());
        var result = _global.fscommand.apply(null, args);
        stack.push(result);
        break;
      case 0x89: // ActionStrictMode
        var mode = stream.readUI8();
        break;
      case 0: // End of actions
        return;
      default:
        throw 'Unknown action code: ' + actionCode;
    }
    stream.position = nextPosition;
  }
}

var ActionTracerFactory = (function() {
  var indentation = 0;
  var tracer = {
    print: function(position, actionCode, stack) {
      var stackDump = [];
      for(var q = 0; q < stack.length; q++) {
        var item = stack[q];
        stackDump.push(item && typeof item === 'object' ?
          '[' + (item.constructor && item.constructor.name ? item.constructor.name : 'Object') + ']' : item);
      }

      var indent = new Array(indentation + 1).join('..');

      console.log('AVM1 trace: ' + indent + position + ': ' +
        ActionNamesMap[actionCode] + '(' + actionCode.toString(16) + '), ' +
        'stack=' + stackDump);
    },
    indent: function() {
      indentation++;
    },
    unindent: function() {
      indentation--;
    },
    message: function(str) {
      console.log('AVM1 trace: ------- ' + str);
    }
  };
  var nullTracer = {
    print: function() {},
    indent: function() {},
    unindent: function() {},
    message: function() {}
  };

  function ActionTracerFactory() {}
  ActionTracerFactory.get = (function() {
    return isAVM1TraceEnabled ? tracer : nullTracer;
  });
  return ActionTracerFactory;
})();

var ActionNamesMap = {
  0x00: 'EOA',
  0x04: 'ActionNextFrame',
  0x05: 'ActionPreviousFrame',
  0x06: 'ActionPlay',
  0x07: 'ActionStop',
  0x08: 'ActionToggleQuality',
  0x09: 'ActionStopSounds',
  0x0A: 'ActionAdd',
  0x0B: 'ActionSubtract',
  0x0C: 'ActionMultiply',
  0x0D: 'ActionDivide',
  0x0E: 'ActionEquals',
  0x0F: 'ActionLess',
  0x10: 'ActionAnd',
  0x11: 'ActionOr',
  0x12: 'ActionNot',
  0x13: 'ActionStringEquals',
  0x14: 'ActionStringLength',
  0x15: 'ActionStringExtract',
  0x17: 'ActionPop',
  0x18: 'ActionToInteger',
  0x1C: 'ActionGetVariable',
  0x1D: 'ActionSetVariable',
  0x20: 'ActionSetTarget2',
  0x21: 'ActionStringAdd',
  0x22: 'ActionGetProperty',
  0x23: 'ActionSetProperty',
  0x24: 'ActionCloneSprite',
  0x25: 'ActionRemoveSprite',
  0x26: 'ActionTrace',
  0x27: 'ActionStartDrag',
  0x28: 'ActionEndDrag',
  0x29: 'ActionStringLess',
  0x2A: 'ActionThrow',
  0x2B: 'ActionCastOp',
  0x2C: 'ActionImplementsOp',
  0x2D: 'ActionFSCommand2',
  0x30: 'ActionRandomNumber',
  0x31: 'ActionMBStringLength',
  0x32: 'ActionCharToAscii',
  0x33: 'ActionAsciiToChar',
  0x34: 'ActionGetTime',
  0x35: 'ActionMBStringExtrac',
  0x36: 'ActionMBCharToAscii',
  0x37: 'ActionMBAsciiToChar',
  0x3A: 'ActionDelete',
  0x3B: 'ActionDelete2',
  0x3C: 'ActionDefineLocal',
  0x3D: 'ActionCallFunction',
  0x3E: 'ActionReturn',
  0x3F: 'ActionModulo',
  0x40: 'ActionNewObject',
  0x41: 'ActionDefineLocal2',
  0x42: 'ActionInitArray',
  0x43: 'ActionInitObject',
  0x44: 'ActionTypeOf',
  0x45: 'ActionTargetPath',
  0x46: 'ActionEnumerate',
  0x47: 'ActionAdd2',
  0x48: 'ActionLess2',
  0x49: 'ActionEquals2',
  0x4A: 'ActionToNumber',
  0x4B: 'ActionToString',
  0x4C: 'ActionPushDuplicate',
  0x4D: 'ActionStackSwap',
  0x4E: 'ActionGetMember',
  0x4F: 'ActionSetMember',
  0x50: 'ActionIncrement',
  0x51: 'ActionDecrement',
  0x52: 'ActionCallMethod',
  0x53: 'ActionNewMethod',
  0x54: 'ActionInstanceOf',
  0x55: 'ActionEnumerate2',
  0x60: 'ActionBitAnd',
  0x61: 'ActionBitOr',
  0x62: 'ActionBitXor',
  0x63: 'ActionBitLShift',
  0x64: 'ActionBitRShift',
  0x65: 'ActionBitURShift',
  0x66: 'ActionStrictEquals',
  0x67: 'ActionGreater',
  0x68: 'ActionStringGreater',
  0x69: 'ActionExtends',
  0x81: 'ActionGotoFrame',
  0x83: 'ActionGetURL',
  0x87: 'ActionStoreRegister',
  0x88: 'ActionConstantPool',
  0x89: 'ActionStrictMode',
  0x8A: 'ActionWaitForFrame',
  0x8B: 'ActionSetTarget',
  0x8C: 'ActionGoToLabel',
  0x8D: 'ActionWaitForFrame2',
  0x8E: 'ActionDefineFunction',
  0x8F: 'ActionTry',
  0x94: 'ActionWith',
  0x96: 'ActionPush',
  0x99: 'ActionJump',
  0x9A: 'ActionGetURL2',
  0x9B: 'ActionDefineFunction',
  0x9D: 'ActionIf',
  0x9E: 'ActionCall',
  0x9F: 'ActionGotoFrame2'
};

// exports for testing
if (typeof GLOBAL !== 'undefined') {
  GLOBAL.executeActions = executeActions;
  GLOBAL.AS2Context = AS2Context;
}
