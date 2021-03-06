#!/usr/bin/env python
# -*- Mode: Python; c-basic-offset: 4; indent-tabs-mode: nil; tab-width: 4 -*-
# vi: set ts=4 sw=4 expandtab:

# ***** BEGIN LICENSE BLOCK *****
# Version: MPL 1.1/GPL 2.0/LGPL 2.1
#
# The contents of this file are subject to the Mozilla Public License Version
# 1.1 (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.mozilla.org/MPL/
#
# Software distributed under the License is distributed on an "AS IS" basis,
# WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
# for the specific language governing rights and limitations under the
# License.
#
# The Original Code is [Open Source Virtual Machine.].
#
# The Initial Developer of the Original Code is
# Adobe System Incorporated.
# Portions created by the Initial Developer are Copyright (C) 2004-2006
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Adobe AS3 Team
#
# Alternatively, the contents of this file may be used under the terms of
# either the GNU General Public License Version 2 or later (the "GPL"), or
# the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
# in which case the provisions of the GPL or the LGPL are applicable instead
# of those above. If you wish to allow use of your version of this file only
# under the terms of either the GPL or the LGPL, and not to allow others to
# use your version of this file under the terms of the MPL, indicate your
# decision by deleting the provisions above and replace them with the notice
# and other provisions required by the GPL or the LGPL. If you do not delete
# the provisions above, a recipient may use your version of this file under
# the terms of any one of the MPL, the GPL or the LGPL.
#
# ***** END LICENSE BLOCK *****

import os
import subprocess
import sys

def compile_abc(target, files, deps=None, configs=None):
    asc_jar = os.environ.get('ASC', os.path.realpath('../../../utils/asc.jar'))
    javacmd = ['java', '-ea', '-DAS3', '-DAVMPLUS', '-classpath', asc_jar, 'macromedia.asc.embedding.ScriptCompiler', '-builtin', '-d']
    if deps:
        javacmd.extend("../%s/%s.abc" % (dep, dep) for dep in deps)
    javacmd.extend(['-out', target])
    javacmd.extend(files)
    javacmd.extend(configs)

    p = subprocess.Popen(javacmd, cwd=target)
    p.wait()

def main():
    configs = sys.argv[1:]
    if configs == []:
        # Build without float suppot by default
        configs = ['-config', 'CONFIG::VMCFG_FLOAT=false']

    compile_abc("builtin", ["builtin.as", "Math.as", "Error.as", "Date.as", "RegExp.as", "IDataInput.as", "IDataOutput.as", "ByteArray.as", "Proxy.as", "XML.as", "Dictionary.as"], configs=configs)
    compile_abc("shell", ["Capabilities.as", "Domain.as", "System.as"], deps=["builtin"], configs=configs)
    compile_abc("avmplus", ["avmplus.as"], deps=["builtin"], configs=configs)
    compile_abc("avm1lib", ["AS2Utils.as", "AS2Broadcaster.as", "AS2MovieClip.as", "AS2Button.as", "AS2TextField.as", "AS2Key.as", "AS2Mouse.as", "AS2Stage.as", "AS2System.as", "AS2Color.as", "AS2Globals.as", "AS2MovieClipLoader.as"], deps=["builtin", "playerGlobal"], configs=configs)

if __name__ == "__main__":
    main()
