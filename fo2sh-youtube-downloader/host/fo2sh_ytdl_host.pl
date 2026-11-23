#!/usr/bin/perl
# Fo2sh YouTube Downloader - helper that Chrome talks to (native messaging).
# Runs yt-dlp + ffmpeg installed by install.command.
use strict;
use warnings;
use JSON::PP;
use POSIX qw(setsid);
use File::Path qw(make_path remove_tree);
use File::Copy qw(move);
use IO::Socket::INET;
use IO::Select;
use Encode qw(decode);

binmode STDIN;
binmode STDOUT;
$| = 1;

my $HOME = $ENV{HOME} || (getpwuid($<))[7];
my $DIR  = $ENV{FO2SH_DIR} || "$HOME/Library/Application Support/Fo2sh";
my $OUT  = $ENV{FO2SH_OUT} || "$HOME/Downloads/YouTube";
my $YT   = "$DIR/yt-dlp";
my $FF   = "$DIR/ffmpeg";
$ENV{PATH} = "$DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" . ($ENV{PATH} || "");

my $JSON = JSON::PP->new->utf8->canonical;

sub read_msg {
    my $n = read(STDIN, my $len, 4);
    return undef unless defined $n && $n == 4;
    my $l = unpack('V', $len);
    my $buf = '';
    while (length($buf) < $l) {
        my $r = read(STDIN, $buf, $l - length($buf), length($buf));
        last unless $r;
    }
    return $JSON->decode($buf);
}

sub send_msg {
    my $j = $JSON->encode($_[0]);
    print STDOUT pack('V', length($j)) . $j;
}

sub run_capture {
    my @cmd = @_;
    my $pid = open(my $fh, '-|') // return ('', -1);
    if ($pid == 0) {
        open(STDERR, '>', '/dev/null');
        exec { $cmd[0] } @cmd or exit 127;
    }
    local $/;
    my $out = <$fh>;
    close $fh;
    return ($out // '', $? >> 8);
}

sub ff_args { return -x $FF ? ('--ffmpeg-location', $DIR) : () }

sub size_of {
    my ($f, $dur) = @_;
    return $f->{filesize} || $f->{filesize_approx} || (($f->{tbr} || 0) * 125 * ($dur || 0)) || 0;
}

# ---------- formats ----------
sub do_formats {
    my ($url) = @_;
    my ($out, $code) = run_capture($YT, '-J', '--no-playlist', '--no-warnings', ff_args(), $url);
    my $info = eval { $JSON->decode($out) };
    return { ok => JSON::PP::false, error => "yt-dlp-$code" } unless $info;
    my $dur = $info->{duration} || 0;
    my (%best, $audio);
    for my $f (@{ $info->{formats} || [] }) {
        my $v = $f->{vcodec} // 'none';
        my $a = $f->{acodec} // 'none';
        if ($v eq 'none' && $a ne 'none') {
            my $s = size_of($f, $dur);
            my $m4a = ($f->{ext} // '') eq 'm4a';
            if (!$audio || ($m4a && !$audio->{m4a}) || ($m4a == $audio->{m4a} && $s > $audio->{size})) {
                $audio = { size => $s, m4a => $m4a };
            }
            next;
        }
        next if $v eq 'none' || !$f->{height};
        my $h = $f->{height};
        my $avc = $v =~ /^avc1/ ? 1 : 0;
        my $s = size_of($f, $dur);
        my $cur = $best{$h};
        # Up to 1080p prefer H.264 (edits smoothly in Premiere), above that take what exists
        my $score = ($h <= 1080 && $avc ? 2 : 1);
        if (!$cur || $score > $cur->{score} || ($score == $cur->{score} && $s > $cur->{size})) {
            $best{$h} = { size => $s, codec => ($avc ? 'H.264' : ($v =~ /^av01/ ? 'AV1' : ($v =~ /^vp0?9/ ? 'VP9' : $v))), score => $score };
        }
    }
    my $asize = $audio ? $audio->{size} : 0;
    my @heights = map {
        { h => $_ + 0, size => int($best{$_}{size} + $asize), codec => $best{$_}{codec} }
    } sort { $b <=> $a } keys %best;
    return {
        ok       => JSON::PP::true,
        title    => $info->{title},
        duration => $dur,
        heights  => \@heights,
        audio    => int($asize),
    };
}

# ---------- download ----------
sub dl_args {
    my ($msg, $stage) = @_;
    my $kind = $msg->{kind} // 'video';
    my @a = (
        '--no-playlist', '--newline', '--no-warnings', '--no-mtime', '--progress',
        '--progress-template', 'download:[PROG]%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s',
        '--print', 'after_move:[FILE]%(filepath)s',
        '-P', $stage, ff_args(),
    );
    if ($kind eq 'audio') {
        my $fmt = $msg->{format} // 'mp3';
        push @a, '-o', '%(title).150B [%(id)s].%(ext)s';
        if ($fmt eq 'm4a') { push @a, '-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a' }
        elsif ($fmt eq 'wav') { push @a, '-f', 'ba', '-x', '--audio-format', 'wav' }
        else { push @a, '-f', 'ba', '-x', '--audio-format', 'mp3', '--audio-quality', '0' }
    } else {
        my $h = int($msg->{height} || 0) || 4320;
        my $f = $h <= 1080
          ? "bv*[height<=$h][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=$h]+ba[ext=m4a]/bv*[height<=$h]+ba/b[height<=$h]/b"
          : "bv*[height<=$h]+ba[ext=m4a]/bv*[height<=$h]+ba/b";
        push @a, '-f', $f, '--merge-output-format', 'mp4', '-o', '%(title).150B [%(height)sp].%(ext)s';
    }
    push @a, $msg->{url};
    return @a;
}

sub do_download {
    my ($msg) = @_;
    my $job = sprintf('%d-%d', time, $$);
    my $stage = "$DIR/staging/$job";
    make_path($OUT, "$DIR/logs", $stage);
    my $log = "$DIR/logs/$job.log";
    open(my $touch, '>', $log) or return send_msg({ type => 'done', ok => JSON::PP::false, error => 'log' });
    close $touch;
    my @args = dl_args($msg, $stage);

    my $pid = fork();
    if (!defined $pid) { return send_msg({ type => 'done', ok => JSON::PP::false, error => 'fork' }) }
    if ($pid == 0) {
        # The download keeps going even if Chrome closes this helper.
        setsid();
        open(STDIN, '<', '/dev/null');
        open(STDOUT, '>>', $log);
        open(STDERR, '>&', \*STDOUT);
        $| = 1;
        my $rc = system($YT, @args);
        $rc = $rc == -1 ? 127 : $rc >> 8;
        print "\n__DONE__ $rc\n";
        # Safety net: if Chrome never picked the file up, put it in Downloads/YouTube
        sleep 180;
        if (-d $stage) {
            opendir(my $dh, $stage);
            for my $f (grep { !/^\./ && !/\.part$/ } readdir $dh) { move("$stage/$f", "$OUT/$f") }
            closedir $dh;
            remove_tree($stage);
        }
        exit 0;
    }

    # Follow the log and report progress to Chrome
    $SIG{PIPE} = sub { exit 0 };
    open(my $fh, '<', $log) or exit 0;
    my ($file, $last, $buf) = ('', '', '');
    my $tail = '';
    while (1) {
        my $chunk = '';
        while (my $line = <$fh>) {
            $buf .= $line;
            next unless $line =~ /\n$/;
            my $l = $buf;
            $buf = '';
            chomp $l;
            $l =~ s/\r//g;
            if ($l =~ /^\[PROG\]\s*([\d.]+)%\|([^|]*)\|(.*)$/) {
                my $p = "$1";
                if ($p ne $last) {
                    $last = $p;
                    send_msg({ type => 'progress', percent => $p + 0, eta => $2, speed => $3 });
                }
            } elsif ($l =~ /^\[FILE\](.+)$/) {
                $file = $1;
            } elsif ($l =~ /^__DONE__ (\d+)/) {
                my $rc = $1;
                if ($rc != 0 || !$file || !-f $file) {
                    send_msg({ type => 'done', ok => JSON::PP::false, error => ($tail || "exit $rc") });
                    exit 0;
                }
                unlink $log;
                serve_file($file, $stage);
                exit 0;
            } elsif ($l =~ /ERROR:\s*(.+)/) {
                $tail = substr($1, 0, 200);
            } elsif ($l =~ /^\[Merger\]|^\[ExtractAudio\]/) {
                send_msg({ type => 'stage', stage => ($l =~ /Merger/ ? 'merge' : 'audio') });
            }
        }
        seek($fh, 0, 1);
        select(undef, undef, undef, 0.3);
    }
}

# Hands the finished file to Chrome through a one-time local link,
# so it shows up in Chrome's downloads like any other download.
sub serve_file {
    my ($file, $stage) = @_;
    (my $name = $file) =~ s{.*/}{};
    my $size = -s $file;
    my $srv = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => 0, Listen => 5, Proto => 'tcp', ReuseAddr => 1);
    my $fallback = sub {
        move($file, "$OUT/$name");
        remove_tree($stage);
        send_msg({ type => 'done', ok => JSON::PP::true, saved => "$OUT/$name", name => (eval { decode('UTF-8', $name) } // $name) });
    };
    return $fallback->() unless $srv;
    my $token = join '', map { sprintf '%02x', int rand 256 } 1 .. 16;
    my $port = $srv->sockport;
    my $uname = eval { decode('UTF-8', $name) } // $name;
    send_msg({ type => 'done', ok => JSON::PP::true, serve => "http://127.0.0.1:$port/$token", name => $uname, size => $size });

    my $sel = IO::Select->new($srv);
    my $deadline = time + 120;
    while (time < $deadline) {
        my @ready = $sel->can_read($deadline - time) or last;
        my $c = $srv->accept or next;
        $c->autoflush(1);
        my $req = '';
        while (my $line = <$c>) { $req .= $line; last if $line =~ /^\r?\n$/ }
        my ($method, $path) = $req =~ /^(\w+)\s+(\S+)/;
        if (!$path || $path ne "/$token") {
            print $c "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            close $c;
            next;
        }
        print $c "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: $size\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        if (($method // '') eq 'HEAD') { close $c; next }
        open(my $in, '<', $file) or last;
        binmode $in;
        my $sent = 0;
        local $SIG{PIPE} = 'IGNORE';
        while (my $n = read($in, my $chunk, 1 << 20)) {
            last unless defined(syswrite_all($c, $chunk));
            $sent += $n;
        }
        close $in;
        close $c;
        if ($sent == $size) {
            remove_tree($stage);
            eval { send_msg({ type => 'served' }) };
            return;
        }
    }
    # Chrome never took it: keep it in Downloads/YouTube instead
    move($file, "$OUT/$name");
    remove_tree($stage);
}

sub syswrite_all {
    my ($fh, $data) = @_;
    my $off = 0;
    while ($off < length $data) {
        my $w = syswrite($fh, $data, length($data) - $off, $off);
        return undef unless defined $w;
        $off += $w;
    }
    return $off;
}

# ---------- update (re-downloads the unpacked yt-dlp build) ----------
sub do_update {
    my $tmp = "$DIR/update-tmp";
    system('rm', '-rf', $tmp);
    make_path("$tmp/out");
    my $zip = "$tmp/yt.zip";
    my $fail = sub { system('rm', '-rf', $tmp); return { ok => JSON::PP::false, error => $_[0] } };
    system('curl', '-fsL', '-o', $zip, 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip') == 0 or return $fail->('download');
    system('unzip', '-oq', $zip, '-d', "$tmp/out") == 0 or return $fail->('unzip');
    my ($exe) = run_capture('find', "$tmp/out", '-type', 'f', '-name', 'yt-dlp_macos');
    ($exe) = split /\n/, $exe;
    return $fail->('no-exe') unless $exe;
    (my $root = $exe) =~ s{/[^/]+$}{};
    system('xattr', '-dr', 'com.apple.quarantine', $root);
    chmod 0755, $exe;
    system('rm', '-rf', "$DIR/yt-dlp-app");
    system('mv', $root, "$DIR/yt-dlp-app") == 0 or return $fail->('move');
    system('rm', '-rf', $tmp);
    my ($v) = run_capture($YT, '--version');
    $v =~ s/\s+$//;
    return { ok => ($v ? JSON::PP::true : JSON::PP::false), output => $v };
}

# ---------- main ----------
my $msg = read_msg() or exit 0;
my $action = $msg->{action} // '';
if ($action eq 'ping') {
    my ($v) = run_capture($YT, '--version');
    $v =~ s/\s+$//;
    my $ff = (-x $FF) || (system('sh', '-c', 'command -v ffmpeg >/dev/null 2>&1') == 0);
    send_msg({ ok => ($v ? JSON::PP::true : JSON::PP::false), ytdlp => $v, ffmpeg => ($ff ? JSON::PP::true : JSON::PP::false) });
} elsif ($action eq 'formats') {
    send_msg(do_formats($msg->{url}));
} elsif ($action eq 'download') {
    do_download($msg);
} elsif ($action eq 'update') {
    send_msg(do_update());
} else {
    send_msg({ ok => JSON::PP::false, error => 'unknown action' });
}
exit 0;
