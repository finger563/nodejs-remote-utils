

define(['q'], function(Q) {
    'use strict';

    return {
	trackedProcesses: ['catkin_make', 'node_main', 'roscore'], // can be changed by the user
	uuidv4: function() {
	    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	    });
	},
	notify: function(level, msg) {  // can be changed by the user
	    console.log(level + ':: ' + msg);
	},
	chunkString: function(str, len) {
	    return String(str).match(new RegExp('(.|[\r\n ]){1,' + len + '}', 'g'));
	},
	sanitizePath: function(path) {
	    return path.replace(/ /g, '\\ ');
	},
	getDeviceType: function(host) {
	    return host['Device ID'] + '+' + host.Architecture;
	},
	range: function(lowEnd,highEnd) {
	    var arr = [],
		c = highEnd - lowEnd + 1;
	    while ( c-- ) {
		arr[c] = highEnd--
	    }
	    return arr;
	},
	testPing: function(ip) {
	    var self = this;
	    var ping = require('ping');
	    return ping.promise.probe(ip)
		.then(function (res) {
		    if (!res.alive)
			throw new String(ip + ' is not reachable.');
		});
	},
	testSSH: function(ip, user) {
	    var self = this;
	    return self.executeOnHost(['echo "hello"'], ip, user)
		.catch(function (err) {
		    throw new String(user.name + '@' + ip + ' not SSH-able: ' + err);
		});
	},
	testArchOS: function(arch, os, ip, user) {
	    var self = this;
	    return self.executeOnHost(['uname -om'], ip, user)
		.then(function (output) {
		    var correctArch = output.stdout.indexOf(arch) > -1;
		    var correctOS = output.stdout.indexOf(os) > -1;
		    if (!correctArch) {
			throw new String('host ' + ip + ':' + arch +
					 ' has incorrect architecture: '+ output.stdout);
		    }
		    if (!correctOS) {
			throw new String('host ' + ip + ':' + os +
					 ' has incorrect OS: '+ output.stdout);
		    }
		});
	},
	testDeviceId: function(deviceId, deviceIdCommand, ip, user) {
	    var self = this;
	    var cmds = [deviceIdCommand];
	    return self.executeOnHost(cmds, ip, user)
		.then(function (output) {
		    var correctDeviceId = output.stdout.indexOf(deviceId) > -1;
		    if (!correctDeviceId) {
			throw new String('host ' + ip + ':' + deviceId +
					 ' has incorrect deviceId: '+ output.stdout);
		    }
		});
	},
	isFree: function(ip, user) {
	    var self = this;
	    var tasks = self.trackedProcesses.map(function(procName) {
		return self.getPidOnHost(procName, ip, user);
	    });
	    return Q.all(tasks)
		.then(function(outputs) {
		    outputs.forEach(function (output) {
			if (output.stdout) {
			    throw new String(ip + ' is already running: ' + output.stdout);
			};
		    });
		});
	},
	getAvailability: function(host, checkTasks) {
	    var self = this;
	    if (checkTasks === undefined)
		checkTasks = true;
	    // test IP connectivity
	    if (host.Interface_list) {
		var tasks = host.Interface_list.map(function(intf) {
		    //self.logger.info('pinging ' +intf.IP);
		    return self.testPing(intf.IP)
			.then(function() {
			    var userTasks = host.Users.map(function(user) {
				self.notify('info','testing ' + user.name + ' on ' + intf.IP);
				return self.testSSH(intf.IP, user)
				    .then(function() {
					return user;
				    });
			    });
			    return Q.any(userTasks);
			})
			.then(function(user) {
			    if (!user)
				return;
			    self.notify('info',intf.IP + ' got valid user: ' + user.name);
			    return self.testArchOS(host.Architecture, host.OS, intf.IP, user)
				.then(function() {
				    return self.testDeviceId(host['Device ID'], 
							     host['Device ID Command'],
							     intf.IP, 
							     user);
				})
				.then(function() {
				    if (checkTasks)
					return self.isFree(intf.IP, user)
				})
				.then(function() {
				    self.notify('info','returning valid host on ' + intf.IP);
				    return {host: host, intf:intf, user:user};
				});
			})
			.catch(function(err) {
			    self.notify('warning', 'Host ' + host['Device ID'] + '+' + host['Architecture'] + ': '+err);
			    //self.notify('error',err);
			});
		});
		return Q.all(tasks);
	    }
	},
	getAvailableHosts: function(hosts, checkTasks) {
	    var self = this;
	    if (checkTasks === undefined)
		checkTasks = true;
	    var tasks = hosts.map(function(host) {
		return self.getAvailability(host, checkTasks);
	    });
	    return Q.all(tasks)
		.then(function(availArray) {
		    var hostsUp = [];
		    for (var i=0; i < availArray.length; i++) {
			for (var j=0; j < availArray[i].length; j++) {
			    if (availArray[i][j]) {
				hostsUp.push(availArray[i][j]);
			    }
			}
		    }
		    return hostsUp;
		});
	},
	executeOnHost: function(cmds, ip, user, stderrCB, stdoutCB) {
	    var self = this;
	    var Client = require('ssh2').Client;
	    var deferred = Q.defer();
	    var output = {
		user: user,
		ip: ip,
		returnCode: -1,
		signal: undefined,
		stdout: '',
		stderr: ''
	    };

	    if ( stderrCB == undefined ) {
		stderrCB = function(data) {
		    return;
		};
	    }

	    var remote_stdout = '';
	    var remote_stderr = '';
	    cmds.push('exit\n');
	    var cmdString = cmds.join('\n');
	    try {
		var conn = new Client();
		conn.on('error', (err) => {
		    deferred.reject('Couldnt connect to ' + ip + ': ' + err);
		});
		conn.on('ready', function() {
		    var opts = {
			pty: true
		    };
		    conn.exec(cmdString, opts, function(err, stream) {
			if (err) { 
			    var msg = 'SSH2 Exec error: ' + err;
			    deferred.reject(msg);
			}
			stream.on('close', function(code, signal) {
			    conn.end();
			    output.returnCode = code;
			    output.signal = signal;
			    output.stdout = remote_stdout.replace(new RegExp(user.name + '@.+\$','gi'), '');
			    for (var c in cmds) {
				output.stdout = output.stdout.replace(new RegExp(cmds[c], 'gi'), '');
			    }
			    output.stderr = remote_stderr;
			    deferred.resolve(output);
			}).on('data', function(data) {
			    //console.log('GOT STDOUT: ' + data);
			    remote_stdout += data;
			    if (typeof stdoutCB === 'function' && stdoutCB(data.toString('utf-8'))) {
				conn.end();
				deferred.reject(data);
			    }
			}).stderr.on('data', function(data) {
			    //console.log('GOT STDERR: ' + data);
			    remote_stderr += data;
			    if (typeof stderrCB === 'function' && stderrCB(data.toString('utf-8'))) {
				conn.end();
				deferred.reject(data);
			    }
			});
		    })
		}).connect({
		    host: ip,
		    port: 22,
		    username: user.name,
		    privateKey: require('fs').readFileSync(user.Key)
		});
	    }
	    catch (err) {
		deferred.reject('Couldnt execute on ' + ip + ': '+ err);
	    }
	    return deferred.promise;
	},
	deployOnHost: function(cmds, ip, user) {
	    var self = this;
	    var Client = require('ssh2').Client;
	    var deferred = Q.defer();
	    var output = {
		user: user,
		ip: ip,
		returnCode: -1,
		signal: undefined,
		stdout: '',
		stderr: ''
	    };

	    var remote_stdout = '';
	    var remote_stderr = '';
	    cmds.push('exit\n');
	    var cmdString = cmds.join('\n');
	    try {
		var conn = new Client();
		conn.on('error', (err) => {
		    deferred.reject('Couldnt connect to ' + ip + ': ' + err);
		});
		conn.on('ready', function() {
		    conn.shell(function(err, stream) {
			if (err) { 
			    var msg = 'SSH2 Exec error: ' + err;
			    throw new String(msg);
			}
			stream.on('close', function(code, signal) {
			    conn.end();
			    output.returnCode = code;
			    output.signal = signal;
			    output.stdout = remote_stdout.replace(new RegExp(user.name + '@.+\$','gi'), '');
			    for (var c in cmds) {
				output.stdout = output.stdout.replace(new RegExp(cmds[c], 'gi'), '');
			    }
			    output.stderr = remote_stderr;
			    deferred.resolve(output);
			}).stdout.on('data', function(data) {
			    remote_stdout += data;
			}).stderr.on('data', function(data) {
			    remote_stderr += data;
			    conn.end();
			    deferred.reject(data);
			});
			stream.end(cmdString);
		    })
		}).connect({
		    host: ip,
		    port: 22,
		    username: user.name,
		    privateKey: require('fs').readFileSync(user.Key)
		});
	    }
	    catch (err) {
		deferred.reject('Couldnt deploy onto: ' + ip + ': ' + err);
	    }
	    return deferred.promise;
	},
	parseMakePercentOutput: function(output) {
	    var regex = /[0-9]+%/gm;
	    var match = null;
	    var retVals = [];
	    while (match = regex.exec(output)) {
		var percent = parseInt(new String(match).replace('%',''), 10);
		retVals.push(percent);
	    }
	    return retVals;
	},
	parseMakeErrorOutput: function(output) {
	    var regex = /^(.*):([0-9]+):[0-9]+: (warning|error): (.*)$/gm;
	    var match = null;
	    var retVals = [];
	    while (match = regex.exec(output)) {
		retVals.push({
		    fileName:       match[1],
		    line:           parseInt(match[2]),
		    type:           match[3],
		    text:           match[4],
		});
	    }
	    return retVals;
	},
	parsePsAuxOutput: function(output) {
	    return output;
	},
	mkdirRemote: function(dir, ip, user) {
	    var self = this;
	    dir = self.sanitizePath(dir);
	    return self.executeOnHost(['mkdir -p ' + dir],
				      ip,
				      user);
	},
	copyToHost: function(from, to, ip, user) {
	    var self = this;
	    var client = require('scp2');
	    //from = self.sanitizePath(from);
	    //to = self.sanitizePath(to);
	    var deferred = Q.defer();
	    try { 
		client.scp(from, {
		    host: ip,
		    username: user.name,
		    privateKey: require('fs').readFileSync(user.Key),
		    path: to
		}, function(err) {
		    if (err)
			deferred.reject('copy to ' + ip + ' failed: '+ err);
		    else {
			deferred.resolve();
		    }
		});
	    }
	    catch (err) {
		deferred.reject('copy to ' + ip + ' failed: '+ err);
	    }
	    return deferred.promise;
	},
	copyFromHost: function(from, to, ip, user) {
	    var self = this;
	    from = self.sanitizePath(from);
	    to = self.sanitizePath(to);
	    var url = require('url'),
		path = require('path'),
		fs = require('fs'),
		unzip = require('unzip'),
		fstream = require('fstream'),
		child_process = require('child_process');
	    
	    var local = to;
	    var remote = user.name + '@' + ip + ':"' + from + '"';

	    var scp = 'scp -o StrictHostKeyChecking=no -i ' + user.Key + ' -r ' + remote + ' ' + local;
	    
	    var deferred = Q.defer();

	    var child = child_process.exec(scp, function(err, stdout, stderr) {
		if (err) {
		    deferred.reject('copy from ' + ip + ' failed: '+err);
		}
		else {
		    deferred.resolve('copied ' + remote + ' into ' + local);
		}
	    });
	    return deferred.promise;
	},
	getPidOnHost: function(procName, ip, user, stdout_cb, stderr_cb) {
	    var self = this;
	    var cmd = 'ps aux | grep -v grep | grep ' + procName;
	    return self.executeOnHost([cmd], ip, user)
		.then(function(output) {
		    output.stdout = output.stdout.match(procName);
		    return output;
		});
	},
	wgetAndUnzipLibrary: function(file_url, dir) {
	    var self = this;
	    var url = require('url'),
		path = require('path'),
		fs = require('fs'),
		unzip = require('unzip'),
		fstream = require('fstream'),
		child_process = require('child_process');
	    var sanitized_dir = self.sanitizePath(dir);
	    // extract the file name
	    var file_name = url.parse(file_url).pathname.split('/').pop();
	    var output_file_name = self.uuidv4() + '_' + file_name;
	    var final_file = path.join(dir, output_file_name);

	    // compose the wget command; -O is output file
	    var wget = 'wget -O ' + self.sanitizePath(final_file) + ' --no-check-certificate ' + file_url;

	    var deferred = Q.defer();

	    // excute wget using child_process' exec function
	    var child = child_process.exec(wget, function(err, stdout, stderr) {
		if (err) {
		    deferred.reject("Couldn't download " + file_url + ' :: ' + stderr);
		}
		else {
		    var readStream = fs.createReadStream(final_file);
		    var writeStream = fstream.Writer(dir);
		    if (readStream == undefined || writeStream == undefined) {
			deferred.reject("Couldn't open " + dir + " or " + final_file);
		    }
		    else {
			writeStream.on('unpipe', () => {
			    deferred.resolve('downloaded and unzipped ' + file_name + ' into ' + dir);
			});

			readStream
			    .pipe(unzip.Parse())
			    .pipe(writeStream);
			fs.unlinkSync(final_file);
		    }
		}
	    });
	    return deferred.promise;
	}
    }
});
