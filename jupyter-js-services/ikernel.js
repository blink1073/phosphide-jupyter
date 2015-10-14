// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
'use strict';
(function (KernelStatus) {
    KernelStatus[KernelStatus["Unknown"] = 0] = "Unknown";
    KernelStatus[KernelStatus["Starting"] = 1] = "Starting";
    KernelStatus[KernelStatus["Idle"] = 2] = "Idle";
    KernelStatus[KernelStatus["Busy"] = 3] = "Busy";
    KernelStatus[KernelStatus["Restarting"] = 4] = "Restarting";
    KernelStatus[KernelStatus["Dead"] = 5] = "Dead";
})(exports.KernelStatus || (exports.KernelStatus = {}));
var KernelStatus = exports.KernelStatus;
//# sourceMappingURL=ikernel.js.map