// Assembles the standard library: installs every lib into an Interp instance.
import installBase from './lib/base.js';
import installString from './lib/string.js';
import installTable from './lib/table.js';
import installMath from './lib/math.js';
import installOs from './lib/os.js';
import installIo from './lib/io.js';
import installCoroutine from './lib/coroutine.js';
import installDebug from './lib/debug.js';
import installPackage from './lib/package.js';

export default function installStdlib(I) {
  installBase(I);
  installString(I);
  installTable(I);
  installMath(I);
  installOs(I);
  installIo(I);
  installCoroutine(I);
  installDebug(I);
  installPackage(I); // last: registers the other libs in package.loaded
  return I;
}
