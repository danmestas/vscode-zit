/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Uri } from 'vscode';
import type { ZitCheckin } from './openedRepository';

export interface ZitUriParams {
    // full filesystem path
    path: string;
    checkin?: ZitCheckin;
    empty?: true;
}

export function fromZitUri(uri: Uri): ZitUriParams {
    return JSON.parse(uri.query);
}

export function toZitUri(uri: Uri, checkin: ZitCheckin = 'current'): Uri {
    const params: ZitUriParams = {
        path: uri.fsPath,
        checkin: checkin,
    };
    return uri.with({
        scheme: 'zit',
        path: uri.path,
        query: JSON.stringify(params),
    });
}

export function toZitEmptyUri(uri: Uri): Uri {
    const params: ZitUriParams = {
        path: uri.fsPath,
        empty: true,
    };
    return uri.with({
        scheme: 'zit',
        path: uri.path,
        query: JSON.stringify(params),
    });
}
